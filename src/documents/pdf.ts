import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export const MAX_PAGES = 10;
// The longer side of a page, enough to read small print.
const PAGE_PIXELS = 1600;

// Fonts a PDF names without embedding them, e.g. Helvetica.
const standardFontDataUrl = new URL(
	"standard_fonts/",
	import.meta.resolve("pdfjs-dist/package.json"),
).pathname;

export type Pages = {
	/** JPEG images of the first `MAX_PAGES` pages. */
	images: Buffer[];
	pageCount: number;
};

/** The first pages of a PDF, rendered as images a model reads. */
export const renderPages = async (data: Buffer): Promise<Pages> => {
	const loading = getDocument({
		data: new Uint8Array(data),
		standardFontDataUrl,
	});

	try {
		const document = await loading.promise;
		const images: Buffer[] = [];
		const shown = Math.min(document.numPages, MAX_PAGES);
		for (let number = 1; number <= shown; number++) {
			const page = await document.getPage(number);
			const { width, height } = page.getViewport({ scale: 1 });
			const viewport = page.getViewport({
				scale: PAGE_PIXELS / Math.max(width, height),
			});
			const canvas = createCanvas(
				Math.ceil(viewport.width),
				Math.ceil(viewport.height),
			);
			await page.render({
				canvas: canvas as unknown as HTMLCanvasElement,
				viewport,
			}).promise;
			images.push(await canvas.encode("jpeg", 80));
			page.cleanup();
		}
		return { images, pageCount: document.numPages };
	} finally {
		await loading.destroy();
	}
};
