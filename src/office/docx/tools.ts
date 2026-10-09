import type { CodemodeTool } from "@earendil-works/pi-codemode";
import { type TSchema, Type } from "typebox";
import { localTool } from "../../codemode/local-tool.ts";
import {
	exportBytes,
	exportFile,
	fileName,
	previewCopy,
	sourceFile,
} from "../files.ts";
import {
	callWorkingCopy,
	closeWorkingCopy,
	createWorkingCopy,
} from "../working-copy.ts";
import { operations } from "./schemas.ts";

const id = Type.String({ minLength: 1 });
const name = Type.String({
	minLength: 1,
	maxLength: 255,
	pattern: "^[^/\\\\\u0000]+$",
});
const object = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const createDocument = async (
	name: string,
	bytes: Buffer | undefined,
	signal: AbortSignal,
) => {
	const copy = await createWorkingCopy("docx", { name, bytes }, signal);
	return { documentId: copy.id, info: copy.info };
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

export const docxTools: readonly CodemodeTool[] = [
	localTool(
		"docx_create",
		"Create an isolated editable DOCX working copy with one blank body paragraph; returns {documentId,info}. RAM handles expire after close/restart/24 idle hours. Simple DOCX compatibility; export creates a derivative, never changes originals.",
		object({ name: Type.Optional(name) }),
		async (args, { signal }) =>
			createDocument(
				fileName("docx", args.name ?? "document.docx"),
				undefined,
				signal,
			),
	),
	localTool(
		"docx_open",
		"Open an immutable RAM file as an isolated DOCX working copy; returns {documentId,info}. Complex Word features have limited round-trip compatibility; inspect info warnings. Tracked-change documents are read-only and revisions are never auto-accepted.",
		object({ fileId: id }),
		async (args, { signal }) => {
			const file = sourceFile("docx", args.fileId);
			return createDocument(file.fileName, file.data, signal);
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
		async (args, { signal }) =>
			createDocument(
				fileName("docx", args.name ?? "copy.docx"),
				await exportBytes("docx", args.documentId, signal),
				signal,
			),
	),
	localTool(
		"docx_export",
		"Save a derivative DOCX to the RAM file store; returns {id,fileName,mimeType,size} for attachment bridges. Never modifies originals. Validate complex layout in Word. Unedited copies export source bytes exactly.",
		object({ documentId: id, fileName: Type.Optional(name) }),
		async (args, { signal }) =>
			exportFile(
				"docx",
				args.documentId,
				args.fileName ?? "document.docx",
				signal,
			),
	),
	localTool(
		"docx_preview",
		"Render an exported derivative using the shared document preview service. Returns provenance, pageCount, shownPages and JPEG images. Requires configured preview service; no edits or original-file changes.",
		object({ documentId: id }),
		async (args, { signal }) => previewCopy("docx", args.documentId, signal),
	),
	localTool(
		"docx_close",
		"Close an isolated DOCX working copy and discard its unsaved RAM edits; immutable original and exported files remain available.",
		object({ documentId: id }),
		async (args) => closeWorkingCopy("docx", args.documentId),
	),
];
