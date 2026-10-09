import { parentPort, workerData } from "node:worker_threads";
import {
	Document,
	type DocumentLoadOptions,
	Paragraph,
	Run,
	Table,
} from "docxmlater";
import type { Static, TSchema } from "typebox";
import Value from "typebox/value";
import { type Operation, operations, type ParagraphInput } from "./schemas.ts";

const port = parentPort;
if (!port) throw new Error("DOCX worker requires a parent port.");
const data: { name: string; bytes?: Uint8Array } = workerData;
const MAX_BYTES = 64 * 1024 * 1024;
const notices = [
	"Simple DOCX compatibility only: complex layout, embedded objects, fields, comments, drawings, headers/footers and custom XML are not editable here; verify the exported derivative in Word. Original files are never modified.",
	"Paragraph and table indices are 1-based, top-level document body only, excluding table-cell paragraphs, nested tables, headers and footers. Indices are current positions, not durable IDs; insertion/deletion shifts later indices. Table columns count physical cells, not a merged grid.",
];
const options: DocumentLoadOptions = {
	revisionHandling: "preserve",
	acceptRevisions: false,
	// The installed ZIP reader checks declared sizes before inflation and actual
	// sizes afterward. JSZip still buffers an entry before measured limits fire.
	sizeLimits: {
		maxSizeMB: 64,
		maxTotalUncompressedMB: 128,
		maxEntryUncompressedMB: 64,
		maxEntryCount: 10_000,
		maxCompressionRatio: 200,
	},
};
let document: Document;
let savedBytes: Buffer;
let revisions = false;
let version = 0;
const paragraphs = () =>
	document
		.getBodyElements()
		.filter((element): element is Paragraph => element instanceof Paragraph);
const tables = () =>
	document
		.getBodyElements()
		.filter((element): element is Table => element instanceof Table);
const checked = <S extends TSchema>(schema: S, args: unknown): Static<S> => {
	if (!Value.Check(schema, args))
		throw new Error("Invalid DOCX operation arguments.");
	return args;
};
const at = <T>(items: T[], index: number, label: string): T => {
	const item = items[index - 1];
	if (!item)
		throw new Error(
			`${label} ${index} does not exist (1-based, ${items.length} available).`,
		);
	return item;
};
const hasMarkup = (
	element: ReturnType<Paragraph["toXML"]>,
	names: RegExp,
): boolean => {
	if (names.test(element.name.split(":").at(-1) ?? "")) return true;
	if (
		element.rawXml &&
		/<(?:\w+:)?(?:drawing|pict|fldChar|instrText|commentRangeStart|commentReference|sectPr|pPrChange|del|ins|tbl)\b/.test(
			element.rawXml,
		)
	)
		return true;
	return (
		element.children?.some(
			(child) => typeof child !== "string" && hasMarkup(child, names),
		) ?? false
	);
};
const assertPlain = (paragraph: Paragraph) => {
	if (
		paragraph._isPartOfMultiParagraphField ||
		paragraph.hasFields() ||
		paragraph.getContent().some((content) => !(content instanceof Run)) ||
		hasMarkup(
			paragraph.toXML(),
			/^(drawing|pict|fldChar|instrText|commentRangeStart|commentReference|sectPr|pPrChange|del|ins)$/,
		)
	) {
		throw new Error(
			"This paragraph contains fields, revisions, comments, drawings or other non-text content; editing it is unsupported and was refused.",
		);
	}
};
const apply = (paragraph: Paragraph, input: ParagraphInput) => {
	if (input.text !== undefined && input.runs !== undefined)
		throw new Error("Specify text or runs, not both.");
	if (input.text !== undefined || input.runs !== undefined) {
		assertPlain(paragraph);
		paragraph.clearContent();
		if (input.text !== undefined) paragraph.addText(input.text);
		else
			for (const run of input.runs ?? [])
				paragraph.addText(run.text, run.format);
	}
	if (input.format) {
		assertPlain(paragraph);
		if (input.format.heading !== undefined)
			paragraph.setStyle(
				input.format.heading === 0
					? "Normal"
					: `Heading${input.format.heading}`,
			);
		if (input.format.alignment) paragraph.setAlignment(input.format.alignment);
	}
};
const info = () => ({
	name: data.name,
	version,
	paragraphCount: paragraphs().length,
	tableCount: tables().length,
	bodyElementCount: document.getBodyElements().length,
	serializedBytes: savedBytes.length,
	readOnly: revisions,
	trackedChanges: revisions,
	parseWarningCount: document.getParseWarnings().length,
	warnings: [
		...notices,
		...(revisions
			? [
					"Tracked changes detected: read-only. No revisions are accepted or rejected. Export/clone retain unchanged source bytes.",
				]
			: []),
		...document.getParseWarnings().slice(0, 100),
	],
});
const snippet = (text: string, offset: number, limit: number) => ({
	text: text.slice(offset, offset + limit),
	totalLength: text.length,
	textOffset: offset,
	nextTextOffset: Math.min(text.length, offset + limit),
	truncated: offset + limit < text.length,
});
const insert = (element: Paragraph | Table, before?: number) => {
	const body = document.getBodyElements();
	const position = before ?? body.length + 1;
	if (position > body.length + 1)
		throw new Error(
			"before must be a 1-based body position or bodyElementCount + 1 to append.",
		);
	document.insertBodyElementAt(position - 1, element);
	return { bodyIndex: position };
};
const dispatch = async (
	operation: Operation,
	args: unknown,
): Promise<unknown> => {
	switch (operation) {
		case "info":
			return info();
		case "export":
			return savedBytes;
		case "read": {
			const a = checked(operations.read, args);
			const items = paragraphs();
			const start = a.start ?? 1;
			const limit = a.limit ?? 100;
			const selected = items.slice(start - 1, start - 1 + limit);
			const textLimit = Math.min(
				a.textLimit ?? 10_000,
				Math.floor(1_000_000 / Math.max(selected.length, 1)),
			);
			const result = selected.map((paragraph, i) => ({
				paragraph: start + i,
				bodyIndex: document.getBodyElements().indexOf(paragraph) + 1,
				...snippet(paragraph.getText(), a.textOffset ?? 0, textLimit),
				style: paragraph.getStyle(),
				heading: paragraph.detectHeadingLevel(),
				runs: paragraph
					.getRuns()
					.slice(0, 100)
					.map((run) => ({
						...snippet(
							run.getText(),
							a.textOffset ?? 0,
							Math.max(
								1,
								Math.floor(
									textLimit / Math.min(paragraph.getRuns().length, 100),
								),
							),
						),
						format: run.getFormatting(),
					})),
				runCount: paragraph.getRuns().length,
				runsTruncated: paragraph.getRuns().length > 100,
			}));
			return {
				paragraphs: result,
				total: items.length,
				nextStart:
					start - 1 + selected.length < items.length
						? start + selected.length
						: null,
			};
		}
		case "replace_text": {
			const a = checked(operations.replace_text, args);
			const targets = a.paragraph
				? [at(paragraphs(), a.paragraph, "Paragraph")]
				: [
						...paragraphs(),
						...(a.includeTables
							? tables().flatMap((table) =>
									table
										.getRows()
										.flatMap((row) =>
											row.getCells().flatMap((cell) => cell.getParagraphs()),
										),
								)
							: []),
					];
			const matching = targets.filter((p) => p.getText().includes(a.find));
			for (const p of matching) assertPlain(p);
			let replacements = 0;
			for (const p of matching)
				replacements += p.replaceTextCrossRun(a.find, a.replacement, {
					caseSensitive: true,
				});
			return {
				replacements,
				notice:
					"Literal, case-sensitive, non-overlapping matches within individual paragraphs; replacement inherits the first matched run's formatting. Never spans paragraph boundaries.",
			};
		}
		case "insert_paragraph": {
			const a = checked(operations.insert_paragraph, args);
			const paragraph = Paragraph.create();
			apply(paragraph, a);
			return insert(paragraph, a.before);
		}
		case "delete_paragraph": {
			const a = checked(operations.delete_paragraph, args);
			const p = at(paragraphs(), a.paragraph, "Paragraph");
			assertPlain(p);
			document.removeElement(p);
			if (!document.getBodyElements().length)
				document.addParagraph(Paragraph.create(""));
			return { deleted: true };
		}
		case "update_paragraph": {
			const a = checked(operations.update_paragraph, args);
			apply(at(paragraphs(), a.paragraph, "Paragraph"), a);
			return { updated: true };
		}
		case "add_table": {
			const a = checked(operations.add_table, args);
			const columns = a.rows[0]?.length ?? 0;
			if (a.rows.some((row) => row.length !== columns))
				throw new Error("Table rows must have equal column counts.");
			const table = Table.create(a.rows.length, columns, {
				width: 9360,
				widthType: "dxa",
				layout: "fixed",
				tableGrid: Array.from({ length: columns }, () =>
					Math.floor(9360 / columns),
				),
			});
			for (const [r, row] of a.rows.entries())
				for (const [c, text] of row.entries()) {
					const cell = table.getCell(r, c);
					cell?.setWidth(Math.floor(9360 / columns));
					cell?.createParagraph(text);
				}
			return insert(table, a.before);
		}
		case "read_table": {
			const a = checked(operations.read_table, args);
			const table = at(tables(), a.table, "Table");
			const rows = table.getRows();
			const start = a.startRow ?? 1;
			const selected = rows.slice(start - 1, start - 1 + (a.limit ?? 50));
			const columnLimit = a.columnLimit ?? 50;
			const textLimit = Math.min(
				a.textLimit ?? 10_000,
				Math.max(
					1,
					Math.floor(1_000_000 / Math.max(selected.length * columnLimit, 1)),
				),
			);
			return {
				table: a.table,
				rowCount: rows.length,
				rows: selected.map((row, i) => ({
					row: start + i,
					cellCount: row.getCells().length,
					cells: row
						.getCells()
						.slice(
							(a.startColumn ?? 1) - 1,
							(a.startColumn ?? 1) - 1 + columnLimit,
						)
						.map((cell, c) => ({
							column: (a.startColumn ?? 1) + c,
							...snippet(
								cell
									.getParagraphs()
									.map((p) => p.getText())
									.join("\n"),
								a.textOffset ?? 0,
								textLimit,
							),
						})),
				})),
				nextStartRow:
					start - 1 + selected.length < rows.length
						? start + selected.length
						: null,
			};
		}
		case "write_table_cell": {
			const a = checked(operations.write_table_cell, args);
			const table = at(tables(), a.table, "Table");
			const cell = at(
				at(table.getRows(), a.row, "Row").getCells(),
				a.column,
				"Physical cell",
			);
			const ps = cell.getParagraphs();
			if (ps.length !== 1 || hasMarkup(cell.toXML(), /^tbl$/))
				throw new Error(
					"Only simple cells with exactly one paragraph and no nested table can be edited.",
				);
			apply(at(ps, 1, "Cell paragraph"), a);
			return { updated: true };
		}
	}
};
const readOnlyOperations = new Set<Operation>([
	"info",
	"read",
	"read_table",
	"export",
]);
const main = async () => {
	if (data.bytes) {
		savedBytes = Buffer.from(data.bytes);
		if (
			savedBytes.length < 4 ||
			savedBytes.length > MAX_BYTES ||
			savedBytes.readUInt32LE(0) !== 0x04034b50
		)
			throw new Error("Expected a DOCX ZIP file no larger than 64 MiB.");
		document = await Document.loadFromBuffer(savedBytes, options);
		for (const name of await document.listParts()) {
			if (!name.endsWith(".xml")) continue;
			const part = await document.getPart(name);
			if (
				part &&
				/<(?:\w+:)?(?:ins|del|moveFrom|moveTo|moveFromRangeStart|moveToRangeStart|\w+PrChange|tblGridChange|numberingChange|cellIns|cellDel|cellMerge)\b/.test(
					part.content.toString(),
				)
			)
				revisions = true;
		}
	} else {
		document = Document.create();
		document.addParagraph(Paragraph.create(""));
		savedBytes = await document.toBuffer();
	}
	port.postMessage({ id: 0, result: info() });
	port.on(
		"message",
		async (message: { id: number; operation: Operation; args: unknown }) => {
			let mutated = false;
			try {
				if (!(message.operation in operations))
					throw new Error("Unknown DOCX operation.");
				const write = !readOnlyOperations.has(message.operation);
				if (write && revisions)
					throw new Error(
						"Documents with tracked changes are read-only; revisions are never auto-accepted.",
					);
				mutated = write;
				const result = await dispatch(message.operation, message.args);
				if (write) {
					const bytes = await document.toBuffer();
					if (bytes.length > MAX_BYTES)
						throw new Error(
							"Edited DOCX exceeds the 64 MiB working-copy limit; operation rolled back.",
						);
					savedBytes = bytes;
					version++;
				}
				port.postMessage({ id: message.id, result });
			} catch (error) {
				let fatal = false;
				if (mutated) {
					try {
						document = await Document.loadFromBuffer(savedBytes, options);
					} catch {
						fatal = true;
					}
				}
				port.postMessage({
					id: message.id,
					error: error instanceof Error ? error.message : String(error),
					fatal,
				});
			}
		},
	);
};
await main().catch((error: unknown) =>
	port.postMessage({
		id: 0,
		error: error instanceof Error ? error.message : String(error),
		fatal: true,
	}),
);
