import type { CodemodeTool } from "@earendil-works/pi-codemode";
import { Type } from "typebox";
import { localTool } from "../codemode/tool.ts";
import { previewFile } from "../documents/preview.ts";
import { officeFormats } from "../files/formats.ts";
import { getFile, putFile } from "../files/store.ts";
import {
	callWorkingCopy,
	closeWorkingCopy,
	createWorkingCopy,
} from "../files/working-copy.ts";
import { id, name, type Operation, operations } from "./schemas.ts";

const MIME = officeFormats.pptx.mimeType;
const handle = { presentationId: id };
const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const fileName = (value: string) => {
	if (
		/[\\/]/.test(value) ||
		[...value].some((character) => character.charCodeAt(0) < 32)
	)
		throw new Error("Use a file name, not a path.");
	return /\.pptx$/i.test(value) ? value : `${value}.pptx`;
};
const create = async (
	name: string,
	bytes: Buffer | undefined,
	signal: AbortSignal,
) => {
	const result = await createWorkingCopy(
		{
			format: "pptx",
			worker: new URL("./worker.ts", import.meta.url),
			name: fileName(name),
			bytes,
		},
		signal,
	);
	return { presentationId: result.id, info: result.info };
};
const call = (
	id: string,
	operation: string,
	args: Record<string, unknown>,
	signal: AbortSignal,
) => callWorkingCopy("pptx", id, operation, args, signal);
const exportBytes = async (id: string, signal: AbortSignal) => {
	const bytes = await call(id, "export", {}, signal);
	if (!(bytes instanceof Uint8Array))
		throw new Error("PPTX worker returned invalid export bytes.");
	signal.throwIfAborted();
	return Buffer.from(bytes);
};
const operationTool = (
	operation: Exclude<Operation, "configure" | "export" | "add_image">,
	description: string,
): CodemodeTool =>
	localTool(
		`pptx_${operation}`,
		description,
		object({ ...operations[operation].properties, ...handle }),
		async ({ presentationId, ...args }, context) =>
			call(presentationId, operation, args, context.signal),
	);

/** PPTX native creation and editing share one package-preserving worker adapter. */
export const presentationTools: readonly CodemodeTool[] = [
	localTool(
		"pptx_create",
		"Create an empty 16:9 PowerPoint RAM working copy (13.333 × 7.5 inches). Optional width AND height in inches. Use pptx_add_slide and named shapes to compose layouts; export to a new fileId before closing/restart. Max 8 copies, 24 idle hours.",
		object({ name: Type.Optional(name), ...operations.configure.properties }),
		async ({ name, width, height }, context) => {
			if ((width === undefined) !== (height === undefined))
				throw new Error("Supply width and height together.");
			const copy = await create(
				name ?? "presentation.pptx",
				undefined,
				context.signal,
			);
			try {
				if (width !== undefined)
					copy.info = await call(
						copy.presentationId,
						"configure",
						{ width, height },
						context.signal,
					);
				return copy;
			} catch (error) {
				await closeWorkingCopy("pptx", copy.presentationId);
				throw error;
			}
		},
	),
	localTool(
		"pptx_open",
		"Open an immutable PPTX fileId as a separate editable RAM working copy. Existing package parts (including charts, notes and unsupported objects) are retained. Structural reads are partial, not visual proof. No legacy PPT/password/ZIP64 support; max 64 MiB compressed, 256 MiB expanded.",
		object({ fileId: id }),
		async ({ fileId }, context) => {
			const file = getFile(fileId);
			if (!/\.pptx$/i.test(file.fileName) && file.mimeType !== MIME)
				throw new Error("Expected a .pptx presentation file.");
			return create(file.fileName, file.data, context.signal);
		},
	),
	operationTool(
		"info",
		"Read canvas size in inches, paginated slides with stable slideId/index/layout/shape count, and up to 100 layouts. Indices are zero-based; IDs remain stable across moves. Report is structural and partial.",
	),
	operationTool(
		"read",
		"Read one slide: paginated shape IDs/names/types/text, up to 100 selected runs per shape (paragraphIndex/runIndex), placement in inches and inherited layout/master decoration. Inherited shapes are read-only; source scopes distinguish colliding IDs. Geometry for group children may be group-local. Text is bounded/truncation reported; preview verifies appearance.",
	),
	operationTool(
		"add_slide",
		"Add a slide using a layoutId from pptx_info, or the blank layout by default. Optional atIndex is zero-based; optional background is six RGB hex digits. Returns stable slideId.",
	),
	operationTool(
		"remove_slide",
		"Remove only the selected slide using native relationship handling. Shared media remains intact. Export creates a new file; source bytes never change.",
	),
	operationTool(
		"move_slide",
		"Move the selected slide to zero-based toIndex, retaining its stable slideId and all content/relationships.",
	),
	operationTool(
		"duplicate_slide",
		"Duplicate a slide, optionally at zero-based atIndex. Native package handling clones charts, embedded workbooks, notes and owned dependencies; layouts/masters/media stay shared. Returns a new slideId.",
	),
	operationTool(
		"add_text",
		"Add a named text box with x/y/w/h in inches. Supply exactly one of plain text or explicit paragraphs [{runs:[{text,style?}],align?}]. Default Arial 18pt dark text. Optional style uses font, size in points, RGB color, bold/italic/underline; align left/center/right.",
	),
	operationTool(
		"update_text",
		"Edit characters of one shape while retaining geometry and existing formatting. Default replaces whole visible text using incremental format-preserving editing. Prefer selection {kind:'run',paragraphIndex,runIndex} to preserve that run's style exactly, or {kind:'range',start,end} (UTF-16, exclusive end). Optional style patches ONLY the selected run/inserted range; without selection applies to all text. Does not modify other shapes/slides. Plain text only; use pptx_replace_text for intentional paragraph/run restructuring.",
	),
	operationTool(
		"replace_text",
		"Intentionally replace the selected text box/shape's entire paragraph/run structure with paragraphs [{runs:[{text,style?}],align?}]. This replaces text formatting but preserves the target geometry and other elements. Use pptx_update_text for format-preserving character edits.",
	),
	operationTool(
		"add_shape",
		"Add a named native rect/roundRect/ellipse/triangle/diamond/arrow/chevron/hexagon/star5/line with x/y/w/h in inches. Optional text, RGB fill/stroke, strokeWidth in points and text style. Default light gray fill, no outline. Native shapes stay editable in PowerPoint.",
	),
	localTool(
		"pptx_add_image",
		"Add PNG/JPEG from immutable fileId with named x/y/w/h placement in inches; fit contain (default, preserves aspect ratio) or fill (stretches). Max 16 MiB image; no URLs/paths/base64 needed.",
		object({ ...operations.add_image.properties, ...handle }),
		async ({ presentationId, ...args }, context) => {
			const file = getFile(args.fileId);
			if (file.mimeType !== "image/png" && file.mimeType !== "image/jpeg")
				throw new Error("Only PNG/JPEG files are supported.");
			if (file.data.length > 16 * 1024 * 1024)
				throw new Error("Image exceeds 16 MiB.");
			return call(
				presentationId,
				"add_image",
				{ ...args, imageBytes: new Uint8Array(file.data) },
				context.signal,
			);
		},
	),
	operationTool(
		"update_shape",
		"Patch only a selected slide shape's placement (x/y/w/h inches), rotation in degrees, RGB fill/stroke and strokeWidth in points; omitted values stay unchanged. Inherited decoration and group containers are not editable.",
	),
	operationTool(
		"remove_shape",
		"Remove only a selected slide shape. Group containers and inherited layout/master decoration are not editable.",
	),
	operationTool(
		"notes",
		"Read slide speaker notes; optional text intentionally replaces the notes body (empty string clears visible notes). Existing unrelated notes parts are retained. Read is bounded to 100,000 characters with truncation flag.",
	),
	localTool(
		"pptx_clone",
		"Clone the current presentation snapshot into an independent RAM working copy, including unsaved edits; source and original working copy stay unchanged.",
		object({ ...handle, name: Type.Optional(name) }),
		async ({ presentationId, name }, context) =>
			create(
				name ?? "presentation-copy.pptx",
				await exportBytes(presentationId, context.signal),
				context.signal,
			),
	),
	localTool(
		"pptx_export",
		"Serialize current working copy to actual PPTX bytes and store a NEW immutable fileId with fileName/MIME/size metadata. Source file and working copy are unchanged. Pass that fileId to attachment tools; max 64 MiB.",
		object({ ...handle, fileName: Type.Optional(name) }),
		async ({ presentationId, fileName: requestedName }, context) => {
			const name = fileName(requestedName ?? "presentation.pptx");
			return putFile({
				data: await exportBytes(presentationId, context.signal),
				fileName: name,
				mimeType: MIME,
			});
		},
	),
	localTool(
		"pptx_preview",
		"Render an exported snapshot through configured Gotenberg and return rendered-image provenance/page coverage. Neither source nor working copy changes. Fails explicitly if rendering is unavailable; structural inspection is not visual verification.",
		object(handle),
		async ({ presentationId }, context) =>
			previewFile(
				{
					data: await exportBytes(presentationId, context.signal),
					fileName: "presentation.pptx",
					mimeType: MIME,
				},
				context.signal,
			),
	),
	localTool(
		"pptx_close",
		"Close a PPTX RAM working copy and discard unsaved edits. Export first. Already-closed handles return closed:false; exported fileIds are unaffected.",
		object(handle),
		async ({ presentationId }) => closeWorkingCopy("pptx", presentationId),
	),
];
