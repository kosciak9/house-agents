import { readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { Model, UserModel } from "@ironcalc/nodejs";

type Request = { id: number; operation: string; args: Record<string, unknown> };
const port = parentPort;
if (!port) throw new Error("Spreadsheet worker requires a parent port.");
const initial = workerData as {
	directory: string;
	bytes?: Uint8Array;
	name: string;
};
const filePath = `${initial.directory}/workbook.xlsx`;
let model: UserModel;
if (initial.bytes) {
	writeFileSync(filePath, initial.bytes);
	try {
		model = UserModel.fromXlsx(filePath, "en", "UTC", "en");
	} finally {
		unlinkSync(filePath);
	}
} else model = new UserModel(initial.name, "en", "UTC", "en");

const compact = () => {
	const bytes = model.toBytes();
	if (bytes.byteLength > 64 * 1024 * 1024)
		throw new Error(
			"Workbook exceeds the 64 MiB internal model budget. Close it and use a smaller source.",
		);
	// No collaborative diffs or unbounded undo history are needed for an isolated editable copy.
	model = UserModel.fromBytes(bytes, "en");
};
compact();

const info = () => ({
	name: model.getName(),
	locale: model.getLocale(),
	language: model.getLanguage(),
	sheets: model.getWorksheetsProperties().map((sheet, index) => ({
		...sheet,
		bounds: model.getSheetDimensions(index),
	})),
});
port.postMessage({ id: 0, result: info() });

const run = (operation: string, args: Record<string, unknown>): unknown => {
	if (operation === "info") return info();
	if (operation === "clone") return model.toBytes();
	if (operation === "load_clone") {
		model = UserModel.fromBytes(args.bytes as Uint8Array, "en");
		return info();
	}
	if (operation === "export") {
		try {
			model.evaluate();
			model.saveToXlsx(filePath);
			return readFileSync(filePath);
		} finally {
			rmSync(filePath, { force: true });
		}
	}
	if (operation === "recalculate") {
		model.evaluate();
		return info();
	}
	if (operation === "add_sheet") {
		if (
			model
				.getWorksheetsProperties()
				.some(
					(sheet) =>
						sheet.name.toLowerCase() === String(args.name).toLowerCase(),
				)
		)
			throw new Error("A sheet with this name already exists.");
		model.newSheet();
		model.renameSheet(
			model.getWorksheetsProperties().length - 1,
			args.name as string,
		);
		return info();
	}
	const sheet = model
		.getWorksheetsProperties()
		.findIndex((entry) => entry.name === args.sheet);
	if (sheet < 0) throw new Error(`Unknown sheet: ${String(args.sheet)}`);
	const row = args.row as number;
	const column = args.column as number;
	const endRow = args.endRow as number;
	const endColumn = args.endColumn as number;
	if (operation === "read") {
		// UserModel exposes formatted/content APIs; the public raw snapshot supplies typed evaluated values.
		const snapshot = Model.fromBytes(model.toBytes(), "en");
		const cells = [];
		let characters = 0;
		for (let r = row; r <= endRow; r++)
			for (let c = column; c <= endColumn; c++) {
				const content = model.getCellContent(sheet, r, c);
				const cell = {
					row: r,
					column: c,
					value: snapshot.getCellValue(sheet, r, c),
					formula: snapshot.getCellFormula(sheet, r, c),
					formatted: model.getFormattedCellValue(sheet, r, c),
					type: model.getCellType(sheet, r, c),
					content,
				};
				characters += JSON.stringify(cell).length;
				if (characters > 2 * 1024 * 1024)
					throw new Error("Read result exceeds 2 MiB. Read a smaller range.");
				cells.push(cell);
			}
		return { sheet: args.sheet, cells };
	}
	if (operation === "write") {
		model.pauseEvaluation();
		try {
			for (const cell of args.cells as {
				row: number;
				column: number;
				value?: string | number | boolean | null;
				formula?: string;
			}[]) {
				if (cell.formula !== undefined)
					model.setUserInput(sheet, cell.row, cell.column, cell.formula);
				else if (cell.value === null)
					model.rangeClearContents(
						sheet,
						cell.row,
						cell.column,
						cell.row,
						cell.column,
					);
				else
					model.setUserInput(
						sheet,
						cell.row,
						cell.column,
						typeof cell.value === "string"
							? `'${cell.value}`
							: typeof cell.value === "boolean"
								? cell.value
									? "TRUE"
									: "FALSE"
								: String(cell.value),
					);
			}
			// resumeEvaluation does not evaluate accumulated edits in 0.8.3.
			model.evaluate();
		} finally {
			model.resumeEvaluation();
			compact();
		}
		return { written: (args.cells as unknown[]).length };
	}
	if (
		[
			"rename_sheet",
			"insert_rows",
			"delete_rows",
			"insert_columns",
			"delete_columns",
			"move_columns",
		].includes(operation)
	) {
		const count = args.count as number;
		const delta = args.delta as number;
		const snapshot = Model.fromBytes(model.toBytes(), "en");
		const literals: {
			sheet: number;
			row: number;
			column: number;
			value: string;
		}[] = [];
		for (const [s, r, c] of snapshot.getAllCells()) {
			const value = snapshot.getCellValue(s, r, c);
			if (
				typeof value !== "string" ||
				snapshot.getCellType(s, r, c) !== 2 ||
				snapshot.getCellFormula(s, r, c)
			)
				continue;
			let destinationRow = r;
			let destinationColumn = c;
			if (s === sheet) {
				if (operation === "insert_rows" && r >= row) destinationRow += count;
				if (operation === "insert_columns" && c >= column)
					destinationColumn += count;
				if (operation === "delete_rows" && r >= row) {
					if (r < row + count) continue;
					destinationRow -= count;
				}
				if (operation === "delete_columns" && c >= column) {
					if (c < column + count) continue;
					destinationColumn -= count;
				}
				if (operation === "move_columns") {
					if (c >= column && c < column + count) destinationColumn = c + delta;
					else if (
						delta > 0 &&
						c >= column + count &&
						c < column + count + delta
					)
						destinationColumn = c - count;
					else if (delta < 0 && c >= column + delta && c < column)
						destinationColumn = c + count;
				}
			}
			if (destinationRow <= 1048576 && destinationColumn <= 16384)
				literals.push({
					sheet: s,
					row: destinationRow,
					column: destinationColumn,
					value,
				});
		}
		model.pauseEvaluation();
		try {
			if (operation === "rename_sheet")
				model.renameSheet(sheet, args.name as string);
			else if (operation === "insert_rows") model.insertRows(sheet, row, count);
			else if (operation === "delete_rows") model.deleteRows(sheet, row, count);
			else if (operation === "insert_columns")
				model.insertColumns(sheet, column, count);
			else if (operation === "delete_columns")
				model.deleteColumns(sheet, column, count);
			else model.moveColumns(sheet, column, count, delta);
			// 0.8.3 structural edits reparse text, including literal =formulas and numeric/date-looking strings.
			// Keep dependency-aware native operations, then restore literal types at their new coordinates.
			for (const cell of literals)
				model.setUserInput(cell.sheet, cell.row, cell.column, `'${cell.value}`);
			model.evaluate();
		} finally {
			model.resumeEvaluation();
		}
	} else if (operation === "style") {
		const properties = args.properties as Record<string, string>;
		for (const [path, value] of Object.entries(properties)) {
			if (path === "font.name") continue;
			// IronCalc's style object names the size `sz`, but its range API uses `size`.
			model.updateRangeStyle(
				sheet,
				row,
				column,
				endRow,
				endColumn,
				path === "font.sz" ? "font.size" : path,
				value,
			);
		}
		if (properties["font.name"] !== undefined) {
			// Font names have no range setter; raw style edits do not reparse cell values.
			const snapshot = Model.fromBytes(model.toBytes(), "en");
			for (let r = row; r <= endRow; r++)
				for (let c = column; c <= endColumn; c++) {
					const style = snapshot.getCellStyle(sheet, r, c);
					style.font = { ...style.font, name: properties["font.name"] };
					snapshot.setCellStyle(sheet, r, c, style);
				}
			model = UserModel.fromBytes(snapshot.toBytes(), "en");
		}
	} else throw new Error(`Unsupported spreadsheet operation: ${operation}`);
	compact();
	return info();
};
port.on("message", ({ id, operation, args }: Request) => {
	try {
		port.postMessage({ id, result: run(operation, args) });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		port.postMessage({
			id,
			error: message,
			fatal: message.includes("model budget"),
		});
	}
});
