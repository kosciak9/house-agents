import { config } from "../config.ts";
import { convertToPdf } from "./gotenberg.ts";
import { renderPages } from "./pdf.ts";

export const previewFile = async (
	file: { data: Buffer; fileName: string; mimeType: string },
	signal: AbortSignal,
): Promise<{
	provenance: string;
	pageCount: number;
	shownPages: number;
	images: { type: "image"; mimeType: "image/jpeg"; data: string }[];
}> => {
	signal.throwIfAborted();
	const url = config().gotenbergUrl;
	if (!url)
		throw new Error(
			"File preview requires config.gotenbergUrl. Configure a reachable Gotenberg service to render previews.",
		);
	const { pdf, engine } = await convertToPdf(url, file, signal);
	const pages = await renderPages(pdf, signal);
	signal.throwIfAborted();
	return {
		provenance: `${engine}-rendered exported copy. Source and working copy unchanged.`,
		pageCount: pages.pageCount,
		shownPages: pages.images.length,
		images: pages.images.map((image) => ({
			type: "image",
			mimeType: "image/jpeg",
			data: image.toString("base64"),
		})),
	};
};
