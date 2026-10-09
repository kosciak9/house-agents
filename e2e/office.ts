// Real Office fixtures and structural inspection, independent of agent adapters.
import * as pptx from "@office-kit/pptx";
import { Document, Paragraph, Table } from "docxmlater";

export const createWordFixture = async (runId: string) => {
	const document = Document.create();
	try {
		const paragraph = Paragraph.create();
		paragraph.addText("Before ");
		paragraph.addText("old ", { bold: true, color: "AA0000" });
		paragraph.addText("phrase", { italic: true, color: "0000AA" });
		paragraph.addText(" after.", { underline: "single" });
		document.addParagraph(paragraph);
		document.addParagraph(
			Paragraph.create().addText(`Untouched ${runId}`, { italic: true }),
		);
		const table = Table.create(2, 2, {
			width: 9360,
			widthType: "dxa",
			layout: "fixed",
			tableGrid: [4680, 4680],
		});
		for (const [r, row] of [
			["Item", "Status"],
			[`Keep ${runId}`, "Pending"],
		].entries()) {
			for (const [c, text] of row.entries()) {
				const cell = table.getCell(r, c);
				if (!cell) throw new Error("Missing fixture table cell.");
				cell.setWidth(4680);
				cell.createParagraph().addText(text, { bold: r === 0 });
			}
		}
		document.addTable(table);
		return await document.toBuffer();
	} finally {
		document.dispose();
	}
};

export const inspectWord = async (bytes: Buffer) => {
	const document = await Document.loadFromBuffer(bytes);
	try {
		return {
			paragraphs: document
				.getBodyElements()
				.filter((element): element is Paragraph => element instanceof Paragraph)
				.map((paragraph) => ({
					text: paragraph.getText(),
					format: paragraph.getFormatting(),
					runs: paragraph.getRuns().map((run) => ({
						text: run.getText(),
						format: run.getFormatting(),
					})),
				})),
			tables: document.getTables().map((table) => ({
				format: table.getFormatting(),
				rows: table.getRows().map((row) =>
					row.getCells().map((cell) => ({
						text: cell
							.getParagraphs()
							.map((paragraph) => paragraph.getText())
							.join("\n"),
						format: cell.getFormatting(),
					})),
				),
			})),
		};
	} finally {
		document.dispose();
	}
};

export const createPresentationFixture = async (runId: string) => {
	const presentation = pptx.createPresentation();
	const first = pptx.addTitleSlide(presentation, `Old title ${runId}`);
	pptx.addSlideTextBox(first, {
		x: pptx.inches(1),
		y: pptx.inches(5),
		w: pptx.inches(8),
		h: pptx.inches(0.6),
		text: `Keep first ${runId}`,
		name: "untouched-caption",
	});
	const second = pptx.addContentSlide(presentation, {
		title: `Untouched second ${runId}`,
		body: "Do not change this content.",
	});
	const shape = pptx.addSlideShape(second, {
		x: pptx.inches(9),
		y: pptx.inches(5),
		w: pptx.inches(1),
		h: pptx.inches(1),
		preset: "ellipse",
		name: "untouched-decoration",
	});
	pptx.setShapeFill(shape, "#008866");
	return Buffer.from(await pptx.savePresentation(presentation));
};

export const inspectPresentation = async (bytes: Buffer) => {
	const presentation = await pptx.loadPresentation(bytes);
	return {
		size: pptx.getSlideSize(presentation),
		slides: pptx.getSlides(presentation).map((slide) => {
			const layout = pptx.getSlideLayout(slide);
			return {
				id: pptx.getSlidePartName(slide),
				layout: layout && pptx.getSlideLayoutPartName(layout),
				shapes: pptx.getSlideShapes(slide).map((shape) => ({
					id: pptx.getShapeId(shape),
					name: pptx.getShapeName(shape),
					kind: pptx.getShapeKind(shape),
					text: pptx.getShapeText(shape),
					bounds: pptx.getShapeBoundsResolved(presentation, shape),
					rotation: pptx.getShapeRotation(shape),
					fill: pptx.getShapeFill(shape),
					runFormats: Array.from(
						{
							length:
								pptx.getShapeKind(shape) === "shape"
									? pptx.getShapeParagraphCount(shape)
									: 0,
						},
						(_, paragraph) =>
							Array.from(
								{ length: pptx.getShapeRunCount(shape, paragraph) },
								(_, run) => pptx.getShapeRunFormat(shape, paragraph, run),
							),
					),
				})),
			};
		}),
	};
};
