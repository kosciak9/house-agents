import path from "node:path";

// Converts files to PDF through Gotenberg, at the deployment's `gotenbergUrl`.

const TIMEOUT_MS = 2 * 60_000;

// What Chromium renders keeps its look; LibreOffice takes everything else.
const CHROMIUM_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const CHROMIUM_IMAGE_TYPES = new Set([
	"image/svg+xml",
	"image/bmp",
	"image/avif",
	"image/x-icon",
	"image/vnd.microsoft.icon",
]);

export type Engine = "Chromium" | "LibreOffice";

export const convertsWithChromium = (mimeType: string): boolean =>
	CHROMIUM_TYPES.has(mimeType) || CHROMIUM_IMAGE_TYPES.has(mimeType);

const escapeHtml = (text: string): string =>
	text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** The file rendered to PDF, and the engine that rendered it. */
export const convertToPdf = async (
	gotenbergUrl: string,
	file: { data: Buffer; fileName: string; mimeType: string },
	signal?: AbortSignal,
): Promise<{ pdf: Buffer; engine: Engine }> => {
	// LibreOffice picks the format by the extension.
	const fileName = path.basename(file.fileName).replace(/[^\w.-]/gu, "_");
	const blob = new Blob([new Uint8Array(file.data)], { type: file.mimeType });
	const form = new FormData();
	let engine: Engine;
	let route: string;
	if (CHROMIUM_TYPES.has(file.mimeType)) {
		engine = "Chromium";
		route = "chromium/convert/html";
		form.append("files", blob, "index.html");
	} else if (CHROMIUM_IMAGE_TYPES.has(file.mimeType)) {
		engine = "Chromium";
		route = "chromium/convert/html";
		const page = `<img src="${escapeHtml(fileName)}" style="max-width:100%">`;
		form.append("files", new Blob([page], { type: "text/html" }), "index.html");
		form.append("files", blob, fileName);
	} else {
		engine = "LibreOffice";
		route = "libreoffice/convert";
		form.append("files", blob, fileName);
	}

	const response = await fetch(new URL(`forms/${route}`, `${gotenbergUrl}/`), {
		method: "POST",
		body: form,
		signal: signal
			? AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), signal])
			: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`Gotenberg (${engine}) failed: ${response.status}`);
	}

	return { pdf: Buffer.from(await response.arrayBuffer()), engine };
};
