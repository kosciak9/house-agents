import * as pptx from "@office-kit/pptx";
import Value from "typebox/value";
import {
	type Operation,
	type OperationArgs,
	operations,
	type Style,
} from "./schemas.ts";

const MAX_BYTES = 64 * 1024 * 1024;
const EMU_PER_INCH = 914_400;
const rgb = (value: string): pptx.HexColor => {
	if (!/^#?[0-9A-Fa-f]{6}$/.test(value))
		throw new Error("Colors must be six RGB hex digits.");
	return `#${value.replace(/^#/, "").toUpperCase()}`;
};
const format = ({ color, ...value }: Style): pptx.TextFormat => ({
	...value,
	...(color ? { color: rgb(color) } : {}),
});

/** Reject oversized/ZIP64/encrypted containers before the library inflates them. */
const checkContainer = (bytes: Uint8Array) => {
	if (bytes.length > MAX_BYTES)
		throw new Error("PPTX files are limited to 64 MiB.");
	const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let end = -1;
	for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--) {
		if (
			data.readUInt32LE(i) === 0x06054b50 &&
			i + 22 + data.readUInt16LE(i + 20) === data.length
		) {
			end = i;
			break;
		}
	}
	if (end < 0) throw new Error("Not a supported PPTX ZIP container.");
	const entries = data.readUInt16LE(end + 10);
	const directorySize = data.readUInt32LE(end + 12);
	let cursor = data.readUInt32LE(end + 16);
	if (
		entries === 65_535 ||
		directorySize === 0xffffffff ||
		cursor === 0xffffffff ||
		data.readUInt16LE(end + 4) ||
		data.readUInt16LE(end + 6)
	)
		throw new Error("ZIP64 and multi-disk PPTX containers are unsupported.");
	if (entries > 10_000 || cursor + directorySize > end)
		throw new Error(
			"PPTX package exceeds supported entry limits or has an invalid directory.",
		);
	let expanded = 0;
	for (let i = 0; i < entries; i++) {
		if (cursor + 46 > end || data.readUInt32LE(cursor) !== 0x02014b50)
			throw new Error("Invalid PPTX ZIP directory.");
		if (data.readUInt16LE(cursor + 8) & 1)
			throw new Error("Encrypted PPTX containers are unsupported.");
		expanded += data.readUInt32LE(cursor + 24);
		if (expanded > 256 * 1024 * 1024)
			throw new Error("Expanded PPTX package exceeds 256 MiB.");
		cursor +=
			46 +
			data.readUInt16LE(cursor + 28) +
			data.readUInt16LE(cursor + 30) +
			data.readUInt16LE(cursor + 32);
	}
	if (cursor > end) throw new Error("Invalid PPTX ZIP directory length.");
};

const validate = <K extends Operation>(
	operation: K,
	args: unknown,
): OperationArgs<K> => {
	const schema = operations[operation];
	if (!Value.Check(schema, args))
		throw new Error(`Invalid pptx_${operation} arguments.`);
	return args;
};
const inchesBounds = (bounds: pptx.ShapeBounds | null) =>
	bounds && {
		x: bounds.x / EMU_PER_INCH,
		y: bounds.y / EMU_PER_INCH,
		w: bounds.w / EMU_PER_INCH,
		h: bounds.h / EMU_PER_INCH,
	};
const geometry = (args: { x: number; y: number; w: number; h: number }) => ({
	x: pptx.inches(args.x),
	y: pptx.inches(args.y),
	w: pptx.inches(args.w),
	h: pptx.inches(args.h),
});

export const createPresentationAdapter = async (bytes?: Uint8Array) => {
	if (bytes) checkContainer(bytes);
	const presentation = bytes
		? await pptx.loadPresentation(bytes)
		: pptx.createPresentation();
	if (pptx.getSlides(presentation).length > 2_000)
		throw new Error("PPTX working copies support at most 2,000 slides.");
	const slideById = (id: string) => {
		const slide = pptx
			.getSlides(presentation)
			.find((slide) => pptx.getSlidePartName(slide) === id);
		if (!slide)
			throw new Error("Slide ID unavailable; read pptx_info for current IDs.");
		return slide;
	};
	const shapeById = (slideId: string, shapeId: number) => {
		const shape = pptx
			.getSlideShapes(slideById(slideId))
			.find((shape) => pptx.getShapeId(shape) === shapeId);
		if (!shape)
			throw new Error(
				"Shape ID unavailable on this slide. Inherited layout/master shapes are read-only.",
			);
		if (pptx.getShapeKind(shape) === "group")
			throw new Error(
				"Group editing is unsupported; select an individual child shape instead.",
			);
		return shape;
	};
	const slideInfo = (slide: pptx.SlideData, index: number) => {
		const layout = pptx.getSlideLayout(slide);
		return {
			slideId: pptx.getSlidePartName(slide),
			index,
			shapeCount: pptx.getSlideShapes(slide).length,
			hidden: pptx.isSlideHidden(slide),
			layout: layout
				? {
						id: pptx.getSlideLayoutPartName(layout),
						name: pptx.getSlideLayoutName(layout),
						type: pptx.getSlideLayoutType(layout),
					}
				: null,
		};
	};
	const info = (offset = 0, limit = 100) => {
		const size = pptx.getSlideSize(presentation);
		const slides = pptx.getSlides(presentation);
		const layouts = pptx.getSlideLayouts(presentation);
		return {
			format: "pptx",
			units: "inches",
			slideCount: slides.length,
			size: size
				? {
						width: size.width / EMU_PER_INCH,
						height: size.height / EMU_PER_INCH,
					}
				: null,
			slides: slides
				.slice(offset, offset + limit)
				.map((slide, i) => slideInfo(slide, offset + i)),
			offset,
			nextOffset: offset + limit < slides.length ? offset + limit : null,
			layouts: layouts.slice(0, 100).map((layout) => ({
				id: pptx.getSlideLayoutPartName(layout),
				name: pptx.getSlideLayoutName(layout),
				type: pptx.getSlideLayoutType(layout),
			})),
			layoutCount: layouts.length,
			provenance: {
				kind: "structural",
				complete: false,
				warning:
					"OOXML structural inspection, not rendered appearance. Unknown parts are retained, not interpreted; SmartArt, complex charts, fields, group transforms, animations and inherited artwork require visual preview. Working copies expire on close, idle timeout or restart.",
			},
		};
	};
	const describeShape = (
		shape: pptx.SlideShapeData,
		source: "slide" | "layout" | "master",
		budget: { remaining: number; remainingRuns: number },
	) => {
		const consume = (value: string) => {
			const result = value.slice(
				0,
				Math.max(0, Math.min(10_000, budget.remaining)),
			);
			budget.remaining -= result.length;
			return { text: result, truncated: result.length < value.length };
		};
		const visibleText = consume(pptx.getShapeText(shape));
		const paragraphs =
			pptx.getShapeKind(shape) === "shape"
				? pptx.getShapeParagraphCount(shape)
				: 0;
		const runs = [];
		let totalRuns = 0;
		for (let p = 0; p < paragraphs; p++) {
			const count = pptx.getShapeRunCount(shape, p);
			totalRuns += count;
			if (p >= 100) continue;
			for (let r = 0; r < Math.min(count, 100); r++) {
				if (
					runs.length >= 100 ||
					budget.remaining <= 0 ||
					budget.remainingRuns <= 0
				)
					break;
				budget.remainingRuns--;
				const f = pptx.getShapeRunFormat(shape, p, r);
				runs.push({
					paragraphIndex: p,
					runIndex: r,
					...consume(pptx.getShapeRunText(shape, p, r)),
					style: f
						? {
								font: f.font?.slice(0, 100),
								size: f.size,
								color: f.color,
								bold: f.bold,
								italic: f.italic,
								underline: f.underline,
							}
						: null,
				});
			}
		}
		return {
			shapeId: pptx.getShapeId(shape),
			name: pptx.getShapeName(shape).slice(0, 200),
			type: pptx.getShapeKind(shape),
			chart: pptx.isChartShape(shape)
				? {
						kind: pptx.getShapeChartKind(shape),
						seriesNames: pptx
							.getShapeChartSeriesNames(shape)
							?.slice(0, 100)
							.map((name) => name.slice(0, 200)),
					}
				: null,
			table: pptx.isTableShape(shape),
			source,
			editable: source === "slide" && pptx.getShapeKind(shape) !== "group",
			preset: pptx.getShapePreset(shape),
			placeholder: pptx.getShapePlaceholderType(shape),
			bounds: inchesBounds(
				source === "slide"
					? pptx.getShapeBoundsResolved(presentation, shape)
					: pptx.getShapeBounds(shape),
			),
			boundsInherited: source === "slide" && !pptx.getShapeBounds(shape),
			rotation: pptx.getShapeRotation(shape),
			...visibleText,
			paragraphCount: paragraphs,
			runCount: totalRuns,
			runs,
			runsTruncated: totalRuns > runs.length,
		};
	};
	const authored = (shape: pptx.SlideShapeData) => ({
		slideId: pptx.getSlidePartName(pptx.getShapeSlide(shape)),
		shapeId: pptx.getShapeId(shape),
	});
	const requireTextShape = (shape: pptx.SlideShapeData) => {
		if (pptx.getShapeKind(shape) !== "shape")
			throw new Error(
				"Text updates support text boxes and ordinary shapes only; tables/charts/media are retained but not text-edited.",
			);
	};
	const save = async () => {
		if (pptx.getPackageSize(presentation) > 256 * 1024 * 1024)
			throw new Error(
				"Expanded PPTX package exceeds 256 MiB; remove large content before exporting.",
			);
		const output = await pptx.savePresentation(presentation);
		if (output.byteLength > MAX_BYTES)
			throw new Error("Export exceeds the 64 MiB file limit.");
		return output;
	};
	const applyParagraphs = (
		shape: pptx.SlideShapeData,
		paragraphs: OperationArgs<"replace_text">["paragraphs"],
		base?: Style,
	) => {
		if (
			paragraphs.reduce(
				(n, p) => n + p.runs.reduce((n, r) => n + r.text.length, 0),
				0,
			) > 100_000
		)
			throw new Error("Text is limited to 100,000 characters per operation.");
		pptx.setShapeParagraphs(
			shape,
			paragraphs.map((p) => ({
				align: p.align,
				runs: p.runs.map((r) => ({
					text: r.text,
					format: format({ ...base, ...r.style }),
				})),
			})),
		);
	};
	const execute = async (
		operation: string,
		args: unknown,
	): Promise<unknown> => {
		switch (operation) {
			case "configure": {
				const a = validate(operation, args);
				if ((a.width === undefined) !== (a.height === undefined))
					throw new Error("Custom width and height must be supplied together.");
				if (a.width !== undefined && a.height !== undefined)
					pptx.setSlideSize(presentation, {
						width: pptx.inches(a.width),
						height: pptx.inches(a.height),
					});
				return info();
			}
			case "info": {
				const a = validate(operation, args);
				return info(a.offset, a.limit);
			}
			case "read": {
				const a = validate(operation, args);
				const slide = slideById(a.slideId);
				const layout = pptx.getSlideLayout(slide);
				const entries = pptx
					.getSlideShapes(slide)
					.map((shape) => ({ shape, source: "slide" as const }));
				const inherited =
					layout && a.includeInherited !== false
						? [
								...pptx
									.getSlideLayoutShapes(presentation, layout)
									.map((shape) => ({ shape, source: "layout" as const })),
								...pptx
									.getSlideMasterShapes(presentation, layout)
									.map((shape) => ({ shape, source: "master" as const })),
							]
						: [];
				const all = [...entries, ...inherited];
				const offset = a.offset ?? 0;
				const limit = a.limit ?? 50;
				const budget = { remaining: 30_000, remainingRuns: 200 };
				const notes = pptx.getSlideNotes(slide);
				return {
					...slideInfo(slide, pptx.getSlides(presentation).indexOf(slide)),
					units: "inches",
					shapes: all
						.slice(offset, offset + limit)
						.map(({ shape, source }) => describeShape(shape, source, budget)),
					totalShapes: all.length,
					offset,
					nextOffset: offset + limit < all.length ? offset + limit : null,
					notes: notes?.slice(0, 10_000) ?? null,
					notesTruncated: (notes?.length ?? 0) > 10_000,
					inheritedGraphicsHidden: pptx.isSlideBackgroundGraphicsHidden(slide),
					masterGraphicsHidden: layout
						? pptx.isSlideLayoutBackgroundGraphicsHidden(layout)
						: null,
					provenance: info(0, 1).provenance,
				};
			}
			case "add_slide": {
				const a = validate(operation, args);
				const count = pptx.getSlides(presentation).length;
				if (count >= 2_000)
					throw new Error("At most 2,000 slides are supported.");
				if (a.atIndex !== undefined && a.atIndex > count)
					throw new Error("Slide insertion index exceeds slide count.");
				const layout = a.layoutId
					? pptx
							.getSlideLayouts(presentation)
							.find(
								(layout) => pptx.getSlideLayoutPartName(layout) === a.layoutId,
							)
					: pptx.findSlideLayoutByType(presentation, "blank");
				if (!layout)
					throw new Error(
						"Layout unavailable; select a layoutId from pptx_info.",
					);
				const slide = pptx.addSlide(presentation, { layout });
				if (a.background) pptx.setSlideBackground(slide, rgb(a.background));
				if (a.atIndex !== undefined)
					pptx.moveSlide(presentation, slide, a.atIndex);
				return slideInfo(slide, pptx.getSlides(presentation).indexOf(slide));
			}
			case "remove_slide": {
				const a = validate(operation, args);
				pptx.removeSlide(presentation, slideById(a.slideId));
				return {
					removed: true,
					slideCount: pptx.getSlides(presentation).length,
				};
			}
			case "move_slide": {
				const a = validate(operation, args);
				const slide = slideById(a.slideId);
				if (a.toIndex >= pptx.getSlides(presentation).length)
					throw new Error("Destination index exceeds slide count.");
				pptx.moveSlide(presentation, slide, a.toIndex);
				return slideInfo(slide, a.toIndex);
			}
			case "duplicate_slide": {
				const a = validate(operation, args);
				const count = pptx.getSlides(presentation).length;
				if (count >= 2_000 || (a.atIndex !== undefined && a.atIndex > count))
					throw new Error("Slide limit or insertion index exceeded.");
				const slide = pptx.duplicateSlide(presentation, slideById(a.slideId));
				if (a.atIndex !== undefined)
					pptx.moveSlide(presentation, slide, a.atIndex);
				return slideInfo(slide, pptx.getSlides(presentation).indexOf(slide));
			}
			case "add_text": {
				const a = validate(operation, args);
				if ((a.text === undefined) === (a.paragraphs === undefined))
					throw new Error("Supply exactly one of text or paragraphs.");
				if (
					a.paragraphs &&
					a.paragraphs.reduce(
						(n, p) => n + p.runs.reduce((n, r) => n + r.text.length, 0),
						0,
					) > 100_000
				)
					throw new Error("Text exceeds 100,000 characters.");
				const shape = pptx.addSlideTextBox(slideById(a.slideId), {
					...geometry(a),
					text: a.text ?? "",
					name: a.name,
				});
				const base = { font: "Arial", size: 18, color: "222222", ...a.style };
				if (a.paragraphs) applyParagraphs(shape, a.paragraphs, base);
				else pptx.setShapeTextFormat(shape, format(base));
				if (a.align) pptx.setShapeAlignment(shape, a.align);
				return authored(shape);
			}
			case "update_text": {
				const a = validate(operation, args);
				const shape = shapeById(a.slideId, a.shapeId);
				requireTextShape(shape);
				if (a.selection?.kind === "run") {
					const { paragraphIndex: p, runIndex: r } = a.selection;
					if (
						p >= pptx.getShapeParagraphCount(shape) ||
						r >= pptx.getShapeRunCount(shape, p)
					)
						throw new Error("Run selection is out of range.");
					pptx.setShapeRunText(shape, p, r, a.text);
					if (a.style) pptx.setShapeRunFormat(shape, p, r, format(a.style));
				} else {
					const range =
						a.selection?.kind === "range"
							? { start: a.selection.start, end: a.selection.end }
							: undefined;
					if (
						range &&
						(range.start > range.end ||
							range.end > pptx.getShapeText(shape).length)
					)
						throw new Error(
							"Text range is out of bounds (UTF-16 offsets, exclusive end).",
						);
					pptx.setShapeText(shape, a.text, { preserveFormatting: true, range });
					if (a.style)
						pptx.setShapeTextFormat(
							shape,
							format(a.style),
							range
								? {
										range: {
											start: range.start,
											end: range.start + a.text.length,
										},
									}
								: undefined,
						);
				}
				return authored(shape);
			}
			case "replace_text": {
				const a = validate(operation, args);
				const shape = shapeById(a.slideId, a.shapeId);
				requireTextShape(shape);
				applyParagraphs(shape, a.paragraphs);
				return authored(shape);
			}
			case "add_shape": {
				const a = validate(operation, args);
				const shape = pptx.addSlideShape(slideById(a.slideId), {
					...geometry(a),
					preset: a.preset,
					text: a.text,
					name: a.name,
				});
				pptx.setShapeFill(shape, rgb(a.fill ?? "E5E7EB"));
				if (a.stroke || a.strokeWidth !== undefined || a.preset === "line")
					pptx.setShapeStroke(shape, {
						color: rgb(a.stroke ?? "64748B"),
						widthEmu: pptx.pt(a.strokeWidth ?? 1),
					});
				else pptx.setShapeNoStroke(shape);
				if (a.text !== undefined)
					pptx.setShapeTextFormat(
						shape,
						format({ font: "Arial", size: 18, color: "222222", ...a.style }),
					);
				return authored(shape);
			}
			case "add_image": {
				if (!args || typeof args !== "object" || !("imageBytes" in args))
					throw new Error("Image bytes are required.");
				const { imageBytes, ...rest } = args;
				const a = validate(operation, rest);
				if (
					!(imageBytes instanceof Uint8Array) ||
					imageBytes.byteLength > 16 * 1024 * 1024
				)
					throw new Error("Image bytes must be at most 16 MiB.");
				const png =
					imageBytes.length >= 8 &&
					Buffer.from(imageBytes.subarray(0, 8)).equals(
						Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
					);
				const jpeg =
					imageBytes[0] === 255 &&
					imageBytes[1] === 216 &&
					imageBytes[2] === 255;
				if (!png && !jpeg)
					throw new Error("Only PNG and JPEG image bytes are supported.");
				return authored(
					pptx.addSlideImage(slideById(a.slideId), imageBytes, {
						...geometry(a),
						name: a.name,
						fit: a.fit ?? "contain",
					}),
				);
			}
			case "update_shape": {
				const a = validate(operation, args);
				const shape = shapeById(a.slideId, a.shapeId);
				if ([a.x, a.y, a.w, a.h].some((v) => v !== undefined)) {
					const b = pptx.getShapeBoundsResolved(presentation, shape);
					if (!b && [a.x, a.y, a.w, a.h].some((v) => v === undefined))
						throw new Error("Unresolved placement requires all of x/y/w/h.");
					pptx.setShapeBounds(shape, {
						x: a.x === undefined ? (b?.x ?? pptx.inches(0)) : pptx.inches(a.x),
						y: a.y === undefined ? (b?.y ?? pptx.inches(0)) : pptx.inches(a.y),
						w: a.w === undefined ? (b?.w ?? pptx.inches(1)) : pptx.inches(a.w),
						h: a.h === undefined ? (b?.h ?? pptx.inches(1)) : pptx.inches(a.h),
					});
				}
				if (a.fill) pptx.setShapeFill(shape, rgb(a.fill));
				if (a.stroke || a.strokeWidth !== undefined)
					pptx.setShapeStroke(shape, {
						color: a.stroke ? rgb(a.stroke) : undefined,
						widthEmu:
							a.strokeWidth === undefined ? undefined : pptx.pt(a.strokeWidth),
					});
				if (a.rotation !== undefined) pptx.setShapeRotation(shape, a.rotation);
				return authored(shape);
			}
			case "remove_shape": {
				const a = validate(operation, args);
				pptx.removeShape(shapeById(a.slideId, a.shapeId));
				return { removed: true };
			}
			case "notes": {
				const a = validate(operation, args);
				const slide = slideById(a.slideId);
				if (a.text !== undefined) pptx.setSlideNotes(slide, a.text);
				const notes = pptx.getSlideNotes(slide);
				return {
					slideId: a.slideId,
					text: notes?.slice(0, 100_000) ?? null,
					truncated: (notes?.length ?? 0) > 100_000,
				};
			}
			case "export":
				validate(operation, args);
				return save();
			default:
				throw new Error(`Unsupported PPTX operation: ${operation}`);
		}
	};
	return { info, execute };
};
