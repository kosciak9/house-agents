import { Type } from "@earendil-works/pi-ai";
import type { CodemodeTool } from "@earendil-works/pi-codemode";
import { config } from "../config.ts";
import { convertToPdf } from "../documents/gotenberg.ts";
import { renderPages } from "../documents/pdf.ts";
import { getFile, putFile } from "../files/store.ts";
import { callWorkbook, closeWorkbook, createWorkbook } from "./runtime.ts";

const XLSX =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const string = () => Type.String({ minLength: 1, maxLength: 1024 });
const row = () => Type.Integer({ minimum: 1, maximum: 1048576 });
const column = () => Type.Integer({ minimum: 1, maximum: 16384 });
const handle = { workbookId: string() };
const sheet = { ...handle, sheet: string() };
const range = {
	...sheet,
	row: row(),
	column: column(),
	endRow: row(),
	endColumn: column(),
};
const record = (input: unknown): Record<string, unknown> => {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error("Expected an argument object.");
	return input as Record<string, unknown>;
};
const text = (args: Record<string, unknown>, key: string): string => {
	const value = args[key];
	if (typeof value !== "string" || value.length === 0 || value.length > 1024)
		throw new Error(`${key} must be a nonempty string (max 1024 characters).`);
	return value;
};
const integer = (
	args: Record<string, unknown>,
	key: string,
	max: number,
	min = 1,
): number => {
	const value = args[key];
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < min ||
		value > max
	)
		throw new Error(`${key} must be an integer from ${min} to ${max}.`);
	return value;
};
const validateRange = (args: Record<string, unknown>) => {
	const r = integer(args, "row", 1048576);
	const c = integer(args, "column", 16384);
	const er = integer(args, "endRow", 1048576);
	const ec = integer(args, "endColumn", 16384);
	if (er < r || ec < c || (er - r + 1) * (ec - c + 1) > 10000)
		throw new Error("Range must be ordered and contain at most 10,000 cells.");
};

// The existing converter has its own HTTP timeout but no caller-signal parameter.
// Stop waiting immediately on cancellation; it cannot alter the editable model.
const abortable = async <T>(
	operation: Promise<T>,
	signal: AbortSignal,
): Promise<T> => {
	signal.throwIfAborted();
	let cancel: () => void = () => undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		cancel = () => reject(new Error("Spreadsheet preview cancelled."));
		signal.addEventListener("abort", cancel, { once: true });
	});
	try {
		return await Promise.race([operation, aborted]);
	} finally {
		signal.removeEventListener("abort", cancel);
	}
};
const tool = (
	operation: string,
	description: string,
	properties: Record<string, Type.TSchema>,
	run?: CodemodeTool["execute"],
): CodemodeTool => ({
	name: `spreadsheet_${operation}`,
	description,
	inputSchema: { ...Type.Object(properties, { additionalProperties: false }) },
	execute: async (input, context) => {
		const args = record(input);
		for (const key of Object.keys(args))
			if (!(key in properties)) throw new Error(`Unknown argument: ${key}`);
		if (run) return run(args, context);
		const id = text(args, "workbookId");
		if ("sheet" in properties) text(args, "sheet");
		if (operation === "read" || operation === "style") validateRange(args);
		if (operation === "add_sheet" || operation === "rename_sheet") {
			const name = text(args, "name");
			if (name.length > 31 || /[\\/*?:[\]]/.test(name))
				throw new Error(
					"Sheet name must be at most 31 characters and contain no Excel forbidden characters.",
				);
		}
		if (
			[
				"insert_rows",
				"delete_rows",
				"insert_columns",
				"delete_columns",
				"move_columns",
			].includes(operation)
		) {
			const rows = operation.endsWith("rows");
			const axis = rows ? "row" : "column";
			const max = rows ? 1048576 : 16384;
			const start = integer(args, axis, max);
			const count = integer(args, "count", max);
			if (start + count - 1 > max)
				throw new Error("Requested rows/columns exceed worksheet limits.");
			if (operation === "move_columns") {
				const delta = integer(args, "delta", 16384, -16384);
				if (start + delta < 1 || start + delta + count - 1 > max)
					throw new Error("Moved columns exceed worksheet limits.");
			}
		}
		if (operation === "write") {
			if (
				!Array.isArray(args.cells) ||
				args.cells.length < 1 ||
				args.cells.length > 10000
			)
				throw new Error("cells must contain 1–10,000 cell edits.");
			let characters = 0;
			for (const inputCell of args.cells) {
				const cell = record(inputCell);
				integer(cell, "row", 1048576);
				integer(cell, "column", 16384);
				for (const key of Object.keys(cell))
					if (!["row", "column", "value", "formula"].includes(key))
						throw new Error(`Unknown cell property: ${key}`);
				if ("formula" in cell === "value" in cell)
					throw new Error("Each edit needs exactly one of value or formula.");
				if ("formula" in cell) {
					if (
						typeof cell.formula !== "string" ||
						!cell.formula.startsWith("=") ||
						cell.formula.length > 32767
					)
						throw new Error(
							"formula must start with =; use English function names and comma separators.",
						);
				} else if (
					!(
						cell.value === null ||
						typeof cell.value === "boolean" ||
						(typeof cell.value === "string" && cell.value.length <= 32767) ||
						(typeof cell.value === "number" && Number.isFinite(cell.value))
					)
				)
					throw new Error(
						"value must be finite number, boolean, string (max 32767) or null to clear.",
					);
				characters += JSON.stringify(cell).length;
				if (characters > 2 * 1024 * 1024)
					throw new Error(
						"Write batch exceeds 2 MiB. Split it into smaller awaited batches.",
					);
			}
		}
		if (operation === "style") {
			const styles = record(args.properties);
			const paths = [
				"font.b",
				"font.i",
				"font.u",
				"font.strike",
				"font.sz",
				"font.name",
				"font.color",
				"fill.color",
				"num_fmt",
				"alignment.horizontal",
				"alignment.vertical",
				"alignment.wrap_text",
			];
			if (Object.keys(styles).length === 0)
				throw new Error("Provide at least one style property.");
			for (const [path, value] of Object.entries(styles)) {
				if (
					!paths.includes(path) ||
					typeof value !== "string" ||
					value.length > 1024
				)
					throw new Error(`Unsupported style property/value: ${path}`);
				if (
					[
						"font.b",
						"font.i",
						"font.u",
						"font.strike",
						"alignment.wrap_text",
					].includes(path) &&
					value !== "true" &&
					value !== "false"
				)
					throw new Error(`${path} requires string true or false.`);
				if (
					path === "font.sz" &&
					(!Number.isFinite(Number(value)) ||
						Number(value) < 1 ||
						Number(value) > 409)
				)
					throw new Error(
						"font.sz must be a number from 1 to 409, encoded as a string.",
					);
				if (path.endsWith(".color") && !/^#[\da-f]{6}$/i.test(value))
					throw new Error(`${path} requires a #RRGGBB color.`);
				if (
					path === "alignment.horizontal" &&
					![
						"left",
						"center",
						"right",
						"general",
						"centerContinuous",
						"distributed",
						"fill",
						"justify",
					].includes(value)
				)
					throw new Error("Invalid horizontal alignment.");
				if (
					path === "alignment.vertical" &&
					!["bottom", "center", "distributed", "justify", "top"].includes(value)
				)
					throw new Error("Invalid vertical alignment.");
			}
		}
		return callWorkbook(id, operation, args, context.signal);
	},
});

const exportBytes = async (
	args: Record<string, unknown>,
	signal: AbortSignal,
): Promise<Buffer> => {
	const bytes = await callWorkbook(
		text(args, "workbookId"),
		"export",
		{},
		signal,
	);
	if (!(bytes instanceof Uint8Array))
		throw new Error("Spreadsheet export did not return XLSX bytes.");
	return Buffer.from(bytes);
};

export const spreadsheetTools: readonly CodemodeTool[] = [
	tool(
		"create",
		"Create an isolated editable RAM workbook; returns {workbookId, info}. Handles survive codemode scripts, not restart; close when finished. English formula/input locale, UTC. Simple data spreadsheets only: unsupported Excel features may be lost.",
		{ name: string() },
		async (input, { signal }) =>
			createWorkbook(text(record(input), "name"), undefined, signal),
	),
	tool(
		"open",
		"Open an XLSX RAM file as an isolated editable copy; returns {workbookId, info}, source bytes stay immutable. Unsupported Excel features may be lost on export. Locale/formulas English, UTC; text dates are not interpreted.",
		{ fileId: string() },
		async (input, { signal }) => {
			const file = getFile(text(record(input), "fileId"));
			if (!file.fileName.toLowerCase().endsWith(".xlsx"))
				throw new Error("Only XLSX files are supported.");
			return createWorkbook(file.fileName, file.data, signal);
		},
	),
	tool(
		"info",
		"Workbook name and sheet names, visibility and used bounds [minRow,maxRow,minColumn,maxColumn].",
		handle,
	),
	tool(
		"read",
		"Read at most 10,000 cells; returns native typed values, formulas, formatted text and error type (16). Coordinates are 1-based and sheet is its exact name.",
		range,
	),
	tool(
		"write",
		"Write typed cells without guessing strings/dates: strings stay literal (even =text); numbers/booleans preserved, null clears. Use separate formula field with =, English names/comma arguments. Entire batch is validated first but engine errors may leave partial edits. Recalculates once after batch.",
		{
			...sheet,
			cells: Type.Array(
				Type.Object({
					row: row(),
					column: column(),
					value: Type.Optional(
						Type.Union([
							Type.String(),
							Type.Number(),
							Type.Boolean(),
							Type.Null(),
						]),
					),
					formula: Type.Optional(Type.String()),
				}),
				{ minItems: 1, maxItems: 10000 },
			),
		},
	),
	tool(
		"move_columns",
		"Move count whole columns starting at column by signed delta; uses native dependency/formula-aware moveColumns, not cell copying.",
		{
			...sheet,
			column: column(),
			count: column(),
			delta: Type.Integer({ minimum: -16384, maximum: 16384 }),
		},
	),
	...(
		["insert_rows", "delete_rows", "insert_columns", "delete_columns"] as const
	).map((operation) =>
		tool(
			operation,
			`${operation.replaceAll("_", " ")} with native formula/dependency updates. Indices/count are 1-based.`,
			{
				...sheet,
				...(operation.endsWith("rows") ? { row: row() } : { column: column() }),
				count: Type.Integer({
					minimum: 1,
					maximum: operation.endsWith("rows") ? 1048576 : 16384,
				}),
			},
		),
	),
	tool("add_sheet", "Add a named empty worksheet.", {
		...handle,
		name: string(),
	}),
	tool("rename_sheet", "Rename sheet using native formula reference updates.", {
		...sheet,
		name: string(),
	}),
	tool(
		"style",
		"Apply native range style properties: font.b/i/u/strike (strings true/false), font.sz/name/color, fill.color, num_fmt, alignment.horizontal/vertical/wrap_text. Colors #RRGGBB. Max 10,000 cells.",
		{ ...range, properties: Type.Record(Type.String(), Type.String()) },
	),
	tool(
		"recalculate",
		"Evaluate workbook using IronCalc (not LibreOffice).",
		handle,
	),
	tool(
		"clone",
		"Create an explicitly isolated copy of an existing workbook, preserving current unsaved edits; returns {workbookId, info}.",
		handle,
		async (input, { signal }) => {
			const args = record(input);
			const bytes = await callWorkbook(
				text(args, "workbookId"),
				"clone",
				{},
				signal,
			);
			const cloned = await createWorkbook("Clone", undefined, signal);
			try {
				return {
					workbookId: cloned.workbookId,
					info: await callWorkbook(
						cloned.workbookId,
						"load_clone",
						{ bytes },
						signal,
					),
				};
			} catch (error) {
				await closeWorkbook(cloned.workbookId);
				throw error;
			}
		},
	),
	tool(
		"export",
		"Export current edits as real XLSX bytes in RAM; returns {id, fileName, mimeType, size}. Pass this id as fileId to file_read for base64 attachment bridge or Telegram delivery. Simple data spreadsheets only; source unchanged.",
		{ ...handle, fileName: string() },
		async (input, { signal }) => {
			const args = record(input);
			const fileName = text(args, "fileName");
			if (!fileName.toLowerCase().endsWith(".xlsx"))
				throw new Error("Export filename must end in .xlsx.");
			return putFile({
				data: await exportBytes(args, signal),
				fileName,
				mimeType: XLSX,
			});
		},
	),
	tool(
		"preview",
		"Render an exported copy via existing Gotenberg/LibreOffice → PDF. Returns JPEG image blocks (return the result or use image(block)); at most first 10 pages. LibreOffice may recalculate differently; preview is not proof of IronCalc values. Does not edit workbook cells or source.",
		handle,
		async (input, { signal }) => {
			const args = record(input);
			const url = config().gotenbergUrl;
			if (!url)
				throw new Error("Spreadsheet preview requires config.gotenbergUrl.");
			const data = await exportBytes(args, signal);
			signal.throwIfAborted();
			const { pdf } = await abortable(
				convertToPdf(url, {
					data,
					fileName: "preview.xlsx",
					mimeType: XLSX,
				}),
				signal,
			);
			signal.throwIfAborted();
			const pages = await abortable(renderPages(pdf), signal);
			signal.throwIfAborted();
			return {
				provenance:
					"LibreOffice-rendered exported copy; may recalculate differently from IronCalc. Workbook unchanged.",
				pageCount: pages.pageCount,
				shownPages: pages.images.length,
				images: pages.images.map((image) => ({
					type: "image",
					data: image.toString("base64"),
					mimeType: "image/jpeg",
				})),
			};
		},
	),
	tool(
		"close",
		"Close a RAM workbook and discard unsaved edits. Exported files and source remain available separately.",
		handle,
		async (input) => closeWorkbook(text(record(input), "workbookId")),
	),
];
