import type { CodemodeTool } from "@earendil-works/pi-codemode";
import { type TSchema, Type } from "typebox";
import { localTool } from "../codemode/tool.ts";
import { previewFile } from "../documents/preview.ts";
import { officeFormats } from "../files/formats.ts";
import { getFile, putFile } from "../files/store.ts";
import {
	callWorkingCopy,
	closeWorkingCopy,
	createWorkingCopy,
} from "../files/working-copy.ts";
import { operations } from "./schemas.ts";

const { mimeType } = officeFormats.docx;
const id = Type.String({ minLength: 1 });
const name = Type.String({
	minLength: 1,
	maxLength: 255,
	pattern: "^[^/\\\\\u0000]+$",
});
const object = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const fileName = (value: string) =>
	value.toLowerCase().endsWith(".docx") ? value : `${value}.docx`;
const worker = new URL("./worker.ts", import.meta.url);
const exported = async (documentId: string, signal: AbortSignal) => {
	const bytes = await callWorkingCopy("docx", documentId, "export", {}, signal);
	if (!(bytes instanceof Uint8Array))
		throw new Error("DOCX worker returned invalid export bytes.");
	const buffer = Buffer.from(bytes);
	if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50)
		throw new Error("DOCX export is not a ZIP archive.");
	return buffer;
};
const description: Record<keyof typeof operations, string> = {
	info: "Inspect DOCX working-copy counts, version, compatibility warnings and tracked-change read-only status.",
	read: "Read paginated top-level body paragraphs with text, styles and the first 100 runs. 1-based paragraph indices exclude table cells/headers/footers. Text offsets are UTF-16 units; use textOffset/textLimit for long paragraphs.",
	replace_text:
		"Replace literal case-sensitive text across adjacent runs within paragraphs, preserving first-match formatting. Default scope is top-level body paragraphs; includeTables includes simple top-level table-cell paragraphs. Refuses fields/revisions/non-text content; never replaces field instructions or spans paragraphs.",
	insert_paragraph:
		"Insert a body paragraph with text OR formatted runs and optional heading/alignment. before is a 1-based BODY ELEMENT position (paragraphs and tables); omitted means append. Positions shift after insert/delete.",
	delete_paragraph:
		"Delete a simple top-level body paragraph by current 1-based paragraph index, excluding table cells. Refuses non-text content. An empty document retains one blank paragraph.",
	update_paragraph:
		"Update a simple top-level body paragraph by 1-based paragraph index. text OR runs replaces its content explicitly; omitted preserves text. Optional format sets heading (0=Normal,1–9=Heading) and alignment. Refuses fields/revisions/comments/images.",
	add_table:
		"Insert a rectangular text table. rows contains equally sized string arrays. before is a 1-based BODY ELEMENT position; omitted appends. Top-level table indices exclude nested tables.",
	read_table:
		"Read a paginated top-level table with 1-based rows and physical cell columns (not merged-grid coordinates). Use startColumn/columnLimit and textOffset/textLimit to paginate wide tables and long text.",
	write_table_cell:
		"Replace text OR formatted runs, or set heading/alignment, in a simple single-paragraph table cell. table, row, column are 1-based; column counts physical cells, not merged grid. Refuses nested tables/complex content; preserves cell/table formatting.",
	export: "Export DOCX working-copy bytes.",
};

export const wordTools: readonly CodemodeTool[] = [
	localTool(
		"docx_create",
		"Create an isolated editable DOCX working copy with one blank body paragraph; returns {documentId,info}. RAM handles expire after close/restart/24 idle hours. Simple DOCX compatibility; export creates a derivative, never changes originals.",
		object({ name: Type.Optional(name) }),
		async (args, { signal }) => {
			const copy = await createWorkingCopy(
				{
					format: "docx",
					worker,
					name: fileName(args.name ?? "document.docx"),
				},
				signal,
			);
			return { documentId: copy.id, info: copy.info };
		},
	),
	localTool(
		"docx_open",
		"Open an immutable RAM file as an isolated DOCX working copy; returns {documentId,info}. Complex Word features have limited round-trip compatibility; inspect info warnings. Tracked-change documents are read-only and revisions are never auto-accepted.",
		object({ fileId: id }),
		async (args, { signal }) => {
			const file = getFile(args.fileId);
			if (
				!file.fileName.toLowerCase().endsWith(".docx") &&
				file.mimeType !== mimeType
			)
				throw new Error(
					"Expected a .docx file, not legacy .doc or a template.",
				);
			const copy = await createWorkingCopy(
				{ format: "docx", worker, name: file.fileName, bytes: file.data },
				signal,
			);
			return { documentId: copy.id, info: copy.info };
		},
	),
	...Object.entries(operations)
		.filter(([operation]) => operation !== "export")
		.map(([operation, schema]) =>
			localTool(
				`docx_${operation}`,
				description[operation as keyof typeof operations],
				object({ documentId: id, ...schema.properties }),
				async (args, { signal }) => {
					const { documentId, ...input } = args;
					return callWorkingCopy("docx", documentId, operation, input, signal);
				},
			),
		),
	localTool(
		"docx_clone",
		"Clone a working copy into an independent handle through preserved DOCX bytes; returns {documentId,info}. Does not change source. Tracked-change clones remain read-only.",
		object({ documentId: id, name: Type.Optional(name) }),
		async (args, { signal }) => {
			const copy = await createWorkingCopy(
				{
					format: "docx",
					worker,
					name: fileName(args.name ?? "copy.docx"),
					bytes: await exported(args.documentId, signal),
				},
				signal,
			);
			return { documentId: copy.id, info: copy.info };
		},
	),
	localTool(
		"docx_export",
		"Save a derivative DOCX to the RAM file store; returns {id,fileName,mimeType,size} for attachment bridges. Never modifies originals. Validate complex layout in Word. Unedited copies export source bytes exactly.",
		object({ documentId: id, fileName: Type.Optional(name) }),
		async (args, { signal }) => {
			const data = await exported(args.documentId, signal);
			signal.throwIfAborted();
			return putFile({
				data,
				fileName: fileName(args.fileName ?? "document.docx"),
				mimeType,
			});
		},
	),
	localTool(
		"docx_preview",
		"Render an exported derivative using the shared document preview service. Returns provenance, pageCount, shownPages and JPEG images. Requires configured preview service; no edits or original-file changes.",
		object({ documentId: id }),
		async (args, { signal }) =>
			previewFile(
				{
					data: await exported(args.documentId, signal),
					fileName: "preview.docx",
					mimeType,
				},
				signal,
			),
	),
	localTool(
		"docx_close",
		"Close an isolated DOCX working copy and discard its unsaved RAM edits; immutable original and exported files remain available.",
		object({ documentId: id }),
		async (args) => closeWorkingCopy("docx", args.documentId),
	),
];
