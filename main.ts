import { App, MarkdownView, Plugin, PluginSettingTab, Setting, type SettingDefinitionItem, debounce } from "obsidian";
import { EditorView } from "@codemirror/view";

type ZoomMode = "reflow" | "magnify";
type ViewKind = "reading" | "editing";

interface ReadingZoomSettings {
	mode: ZoomMode;
	enableInEditing: boolean;
	minZoom: number;
	maxZoom: number;
	trackpadPinch: boolean;
	twoFingerTapReset: boolean;
	resetOnFileChange: boolean;
	showIndicator: boolean;
}

const DEFAULT_SETTINGS: ReadingZoomSettings = {
	mode: "reflow",
	enableInEditing: true,
	minZoom: 0.5,
	maxZoom: 5,
	trackpadPinch: true,
	twoFingerTapReset: true,
	resetOnFileChange: true,
	showIndicator: true,
};

interface Point {
	x: number;
	y: number;
}

interface ZoomState {
	zoom: number;
	path: string | null;
	/** Sizer width at 100 %, used in magnify mode so content scales instead of reflowing. */
	baseWidth: number | null;
}

interface Parts {
	kind: ViewKind;
	scroller: HTMLElement;
	sizer: HTMLElement;
}

interface PinchGesture {
	host: HTMLElement;
	win: Window;
	startDist: number;
	startZoom: number;
	startTime: number;
	startMid: Point;
	lastMid: Point;
	pendingMid: Point;
	pendingZoom: number;
	moved: boolean;
	frame: number | null;
}

const READING_SELECTOR = ".markdown-reading-view";
const EDITING_SELECTOR = ".markdown-source-view";
const TAP_MAX_MS = 300;
const MOVE_THRESHOLD_PX = 10;
const SNAP_TO_ONE = 0.05;
/** Above this many sections, zoomed notes keep Obsidian's lazy rendering (wider margin). */
const MAX_SECTIONS_FULL_RENDER = 1500;

function getParts(host: HTMLElement): Parts | null {
	if (host.matches(READING_SELECTOR)) {
		const scroller = host.querySelector<HTMLElement>(":scope > .markdown-preview-view");
		const sizer = scroller?.querySelector<HTMLElement>(":scope > .markdown-preview-sizer");
		return scroller && sizer ? { kind: "reading", scroller, sizer } : null;
	}
	const scroller = host.querySelector<HTMLElement>(".cm-scroller");
	const sizer = scroller?.querySelector<HTMLElement>(":scope > .cm-sizer");
	return scroller && sizer ? { kind: "editing", scroller, sizer } : null;
}

/** Internal reading-view renderer (not in the public API); every member is optional. */
interface PreviewRenderer {
	renderedWidth?: number;
	/** Extra area rendered above/below the viewport, in viewport heights (default 1). */
	renderExtra?: number;
	sections?: unknown[];
	onResize?: () => void;
	onRendered?: (cb: () => void) => void;
}

/** The top-level section element of the reading view at a screen point. */
function sectionAt(host: HTMLElement, sizer: HTMLElement, p: Point): HTMLElement | null {
	let el = host.doc.elementFromPoint(p.x, p.y) as HTMLElement | null;
	if (!el || !sizer.contains(el) || el === sizer) return null;
	while (el.parentElement && el.parentElement !== sizer) el = el.parentElement;
	return el.parentElement === sizer ? el : null;
}

function distance(a: Touch, b: Touch): number {
	return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function midpoint(a: Touch, b: Touch): Point {
	return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

export default class ReadingZoomPlugin extends Plugin {
	settings: ReadingZoomSettings;
	private states = new Map<HTMLElement, ZoomState>();
	private gesture: PinchGesture | null = null;
	private indicatorTimers = new WeakMap<HTMLElement, number>();
	/** Renderers whose render margin we widened, with their original value. */
	private tunedRenderers = new Map<PreviewRenderer, number>();
	private pendingImageHosts = new Set<HTMLElement>();
	private flushImageHosts = debounce(() => {
		for (const host of this.pendingImageHosts) {
			const view = host.isConnected ? this.findView(host) : null;
			// Width unchanged, so this only re-measures the rendered sections.
			if (view) this.getRenderer(view)?.onResize?.();
		}
		this.pendingImageHosts.clear();
	}, 100, true);
	private finishWheel = debounce((el: HTMLElement) => this.commit(el), 200, true);

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new ReadingZoomSettingTab(this.app, this));

		this.registerWindow(window);
		this.registerEvent(this.app.workspace.on("window-open", (_w, win) => this.registerWindow(win)));
		this.registerEvent(this.app.workspace.on("file-open", () => this.onFileOpen()));

		this.addCommand({
			id: "zoom-in",
			name: "Zoom in",
			checkCallback: (checking) => this.runZoomCommand(checking, 1.25),
		});
		this.addCommand({
			id: "zoom-out",
			name: "Zoom out",
			checkCallback: (checking) => this.runZoomCommand(checking, 0.8),
		});
		this.addCommand({
			id: "zoom-reset",
			name: "Reset zoom",
			checkCallback: (checking) => this.runZoomCommand(checking, null),
		});
	}

	onunload() {
		this.gesture = null;
		for (const el of this.states.keys()) this.clearEl(el);
		this.states.clear();
		for (const [renderer, extra] of this.tunedRenderers) renderer.renderExtra = extra;
		this.tunedRenderers.clear();
	}

	async loadSettings() {
		const data = (await this.loadData()) as Partial<ReadingZoomSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...data };
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Start over at 100 % everywhere (used when the mode or scope changes). */
	resetAll() {
		for (const el of this.states.keys()) this.setZoom(el, 1);
	}

	/** The zoomable view (reading or editing) containing `target`, if zooming applies there. */
	private hostFrom(target: EventTarget | null): HTMLElement | null {
		const el = target as HTMLElement | null;
		if (!el || typeof el.closest !== "function") return null;
		// Canvas has its own pinch zoom; leave it alone.
		if (el.closest(".canvas-wrapper")) return null;
		const selector = this.settings.enableInEditing
			? `${READING_SELECTOR}, ${EDITING_SELECTOR}`
			: READING_SELECTOR;
		const host = el.closest<HTMLElement>(selector);
		return host && getParts(host) ? host : null;
	}

	// ---------------------------------------------------------------- events

	private registerWindow(win: Window) {
		const doc = win.document;
		const opts: AddEventListenerOptions = { capture: true, passive: false };
		this.registerDomEvent(doc, "touchstart", (e) => this.onTouchStart(e, win), opts);
		this.registerDomEvent(doc, "touchmove", (e) => this.onTouchMove(e), opts);
		this.registerDomEvent(doc, "touchend", (e) => this.onTouchEnd(e), opts);
		this.registerDomEvent(doc, "touchcancel", (e) => this.onTouchEnd(e), opts);
		this.registerDomEvent(doc, "wheel", (e) => this.onWheel(e), opts);
		// `load` doesn't bubble, but capture sees it. Images that finish loading in a
		// zoomed reading view change their section's height: have Obsidian re-measure.
		this.registerDomEvent(doc, "load", (e) => this.onMediaLoad(e), { capture: true });

		// iOS WebKit fires its own gesture events for pinches; suppress them in zoomable views.
		const onGesture = (e: Event) => {
			if (this.hostFrom(e.target)) e.preventDefault();
		};
		for (const type of ["gesturestart", "gesturechange"]) {
			doc.addEventListener(type, onGesture, opts);
			this.register(() => doc.removeEventListener(type, onGesture, opts));
		}
	}

	private onTouchStart(e: TouchEvent, win: Window) {
		if (e.touches.length !== 2) {
			if (e.touches.length > 2) this.gesture = null;
			return;
		}
		const [a, b] = [e.touches[0], e.touches[1]];
		const host = this.hostFrom(a.target);
		if (!host || host !== this.hostFrom(b.target)) return;

		if (e.cancelable) e.preventDefault();
		const mid = midpoint(a, b);
		const zoom = this.getState(host).zoom;
		this.gesture = {
			host,
			win,
			startDist: Math.max(distance(a, b), 1),
			startZoom: zoom,
			startTime: Date.now(),
			startMid: mid,
			lastMid: mid,
			pendingMid: mid,
			pendingZoom: zoom,
			moved: false,
			frame: null,
		};
	}

	private onTouchMove(e: TouchEvent) {
		const g = this.gesture;
		if (!g || e.touches.length < 2) return;
		if (e.cancelable) e.preventDefault();
		e.stopPropagation();

		const [a, b] = [e.touches[0], e.touches[1]];
		const dist = distance(a, b);
		const mid = midpoint(a, b);
		if (
			!g.moved &&
			(Math.abs(dist - g.startDist) > MOVE_THRESHOLD_PX ||
				Math.hypot(mid.x - g.startMid.x, mid.y - g.startMid.y) > MOVE_THRESHOLD_PX)
		) {
			g.moved = true;
		}
		g.pendingZoom = this.clamp((g.startZoom * dist) / g.startDist);
		g.pendingMid = mid;

		if (g.frame === null) {
			g.frame = g.win.requestAnimationFrame(() => {
				g.frame = null;
				this.flushGesture(g);
			});
		}
	}

	private onTouchEnd(e: TouchEvent) {
		const g = this.gesture;
		if (!g || e.touches.length >= 2) return;
		this.gesture = null;

		if (g.frame !== null) {
			g.win.cancelAnimationFrame(g.frame);
			g.frame = null;
			this.flushGesture(g);
		}
		if (!g.moved && Date.now() - g.startTime < TAP_MAX_MS && this.settings.twoFingerTapReset) {
			this.setZoom(g.host, 1, g.startMid);
		}
		this.commit(g.host);
	}

	private flushGesture(g: PinchGesture) {
		// Anchor on the previous midpoint and move it to the new one: zooms and pans at once.
		this.setZoom(g.host, g.pendingZoom, g.lastMid, g.pendingMid);
		g.lastMid = g.pendingMid;
	}

	private onWheel(e: WheelEvent) {
		// Trackpad pinch arrives as ctrl+wheel in Chromium.
		if (!e.ctrlKey || !this.settings.trackpadPinch) return;
		const host = this.hostFrom(e.target);
		if (!host) return;
		e.preventDefault();
		e.stopPropagation();

		const raw = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
		const delta = Math.max(-50, Math.min(50, raw));
		const zoom = this.getState(host).zoom * Math.exp(-delta * 0.01);
		this.setZoom(host, zoom, { x: e.clientX, y: e.clientY });
		this.finishWheel(host);
	}

	private onMediaLoad(e: Event) {
		const el = e.target as HTMLElement | null;
		if (!el || typeof el.closest !== "function") return;
		const host = el.closest<HTMLElement>(`${READING_SELECTOR}.reading-zoom-scaled`);
		if (!host) return;
		this.pendingImageHosts.add(host);
		this.flushImageHosts();
	}

	private onFileOpen() {
		for (const [el, state] of this.states) {
			if (!el.isConnected) {
				this.states.delete(el);
				continue;
			}
			const view = this.findView(el);
			const path = view?.file?.path ?? null;
			if (path === state.path) continue;
			state.path = path;
			if (state.zoom === 1) continue;
			if (this.settings.resetOnFileChange) {
				state.zoom = 1;
				this.applyStyles(el, state);
			}
			// Re-tune for the new note (its section count decides full vs. lazy rendering).
			const renderer = view && el.matches(READING_SELECTOR) ? this.getRenderer(view) : null;
			if (renderer) {
				const zoom = state.zoom;
				// The new note renders asynchronously; tune once its sections exist.
				const tune = () => this.tuneRenderMargin(renderer, zoom);
				tune();
				if (typeof renderer.onRendered === "function") renderer.onRendered(tune);
			}
		}
	}

	private runZoomCommand(checking: boolean, factor: number | null): boolean {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return false;
		const reading = view.getMode() === "preview";
		if (!reading && !this.settings.enableInEditing) return false;
		const host = view.containerEl.querySelector<HTMLElement>(
			reading ? READING_SELECTOR : EDITING_SELECTOR
		);
		if (!host || !getParts(host)) return false;
		if (!checking) {
			const zoom = factor === null ? 1 : this.getState(host).zoom * factor;
			this.setZoom(host, zoom);
			this.commit(host);
		}
		return true;
	}

	// ------------------------------------------------------------------ zoom

	private clamp(zoom: number): number {
		return Math.max(this.settings.minZoom, Math.min(this.settings.maxZoom, zoom));
	}

	private getState(el: HTMLElement): ZoomState {
		let state = this.states.get(el);
		if (!state) {
			state = { zoom: 1, path: this.findView(el)?.file?.path ?? null, baseWidth: null };
			this.states.set(el, state);
		}
		return state;
	}

	private findView(el: HTMLElement): MarkdownView | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.containerEl.contains(el)) return view;
		}
		return null;
	}

	private getEditorView(el: HTMLElement): EditorView | null {
		const editor = this.findView(el)?.editor as { cm?: EditorView } | undefined;
		return editor?.cm ?? null;
	}

	/**
	 * Set the zoom of a view, keeping the content point under `anchor`
	 * (client coordinates) at `target` (defaults to `anchor`, or the view centre).
	 */
	private setZoom(el: HTMLElement, zoom: number, anchor?: Point, target?: Point) {
		const parts = getParts(el);
		if (!parts) return;
		const state = this.getState(el);
		zoom = this.clamp(zoom);

		if (!anchor) {
			const r = parts.scroller.getBoundingClientRect();
			anchor = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
		}
		const to = target ?? anchor;

		if (parts.kind === "editing") {
			this.setEditingZoom(el, parts, state, zoom, anchor, to);
		} else {
			this.setReadingZoom(el, parts, state, zoom, anchor, to);
		}
		this.showIndicator(el, zoom);
	}

	private setReadingZoom(
		el: HTMLElement,
		{ scroller, sizer }: Parts,
		state: ZoomState,
		zoom: number,
		anchor: Point,
		to: Point
	) {
		// Anchor vertically on the rendered section under the point (Obsidian only renders
		// visible sections, so the sizer's total height is an estimate), horizontally on the sizer.
		const block = sectionAt(el, sizer, anchor);
		const blockBefore = block?.getBoundingClientRect();
		const fy = blockBefore && blockBefore.height ? (anchor.y - blockBefore.top) / blockBefore.height : 0;
		const sizerBefore = sizer.getBoundingClientRect();
		const fx = sizerBefore.width ? (anchor.x - sizerBefore.left) / sizerBefore.width : 0.5;

		const leavingOne = state.zoom === 1 && zoom !== 1;
		if (this.settings.mode === "magnify" && leavingOne) {
			state.baseWidth = sizer.offsetWidth;
		}
		state.zoom = zoom;
		this.applyStyles(el, state);

		if (leavingOne) {
			// Attach the whole note before content starts changing size (see tuneRenderMargin).
			const view = this.findView(el);
			const renderer = view ? this.getRenderer(view) : null;
			if (renderer) {
				this.tuneRenderMargin(renderer, zoom);
				renderer.onResize?.();
			}
		}

		if (block && blockBefore) {
			const r = block.getBoundingClientRect();
			scroller.scrollTop += r.top + fy * r.height - to.y;
		} else {
			scroller.scrollTop += anchor.y - to.y;
		}
		if (this.settings.mode === "magnify") {
			const r = sizer.getBoundingClientRect();
			scroller.scrollLeft += r.left + fx * r.width - to.x;
		}
	}

	/**
	 * Obsidian's reading view caches section heights and only re-measures them when the
	 * pane width changes. After a font-size change, force a full re-measure (internal API,
	 * guarded) and keep the section at the top of the pane where it was.
	 */
	private getRenderer(view: MarkdownView): PreviewRenderer | null {
		return (view.previewMode as unknown as { renderer?: PreviewRenderer }).renderer ?? null;
	}

	/**
	 * Obsidian attaches only the sections near the viewport and positions them from cached
	 * heights. Zooming changes those heights without changing the pane width, which is the
	 * only thing that makes Obsidian re-measure, so sections pop in and out at the wrong
	 * time. While zoomed, keep the whole note attached (huge render margin) so the layout
	 * is plain document flow. Very long notes fall back to a wide margin to stay fast.
	 */
	private tuneRenderMargin(renderer: PreviewRenderer, zoom: number) {
		if (typeof renderer.renderExtra !== "number") return;
		if (!this.tunedRenderers.has(renderer)) this.tunedRenderers.set(renderer, renderer.renderExtra);
		const original = this.tunedRenderers.get(renderer) ?? 1;
		if (zoom === 1) {
			renderer.renderExtra = original;
			this.tunedRenderers.delete(renderer);
			return;
		}
		const sectionCount = renderer.sections?.length ?? 0;
		renderer.renderExtra = sectionCount <= MAX_SECTIONS_FULL_RENDER ? 1e6 : Math.max(original, 3 * zoom);
	}

	private remeasureReading(el: HTMLElement, view: MarkdownView) {
		const renderer = this.getRenderer(view);
		const parts = getParts(el);
		if (!renderer || typeof renderer.onResize !== "function" || !parts) return;
		const { scroller, sizer } = parts;
		this.tuneRenderMargin(renderer, this.getState(el).zoom);

		const top = scroller.getBoundingClientRect();
		const probe = { x: top.left + top.width / 2, y: top.top + 1 };
		const block = sectionAt(el, sizer, probe);
		const offset = block ? block.getBoundingClientRect().top - top.top : 0;

		renderer.renderedWidth = 0;
		renderer.onResize();

		const restore = () => {
			if (!block || !block.isConnected) return;
			const now = scroller.getBoundingClientRect().top;
			scroller.scrollTop += block.getBoundingClientRect().top - now - offset;
		};
		if (typeof renderer.onRendered === "function") renderer.onRendered(restore);
		else el.win.setTimeout(restore, 50);
	}

	private setEditingZoom(
		el: HTMLElement,
		{ scroller }: Parts,
		state: ZoomState,
		zoom: number,
		anchor: Point,
		to: Point
	) {
		// CodeMirror only renders visible lines, so anchor on a document position
		// and let CodeMirror scroll it back into place after re-measuring.
		const cm = this.getEditorView(el);
		let pos: number | null = null;
		let offsetInLine = 0;
		if (cm) {
			pos = cm.posAtCoords(anchor, false);
			const coords = cm.coordsAtPos(pos);
			if (coords) offsetInLine = anchor.y - coords.top;
		}

		const ratio = zoom / state.zoom;
		state.zoom = zoom;
		this.applyStyles(el, state);

		if (cm && pos !== null) {
			const top = scroller.getBoundingClientRect().top;
			const yMargin = Math.max(0, to.y - top - offsetInLine * ratio);
			cm.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start", yMargin }) });
		}
	}

	private applyStyles(el: HTMLElement, state: ZoomState) {
		const parts = getParts(el);
		if (!parts) return;
		const zoomed = state.zoom !== 1;

		// Scale text via Obsidian's font-size variable and images via a per-image CSS zoom
		// (see styles.css). Never CSS-zoom a container: Obsidian and CodeMirror measure
		// content inside it in unzoomed units, which breaks their lazy rendering.
		// Base values come from the parent so they follow Obsidian's font settings.
		el.style.removeProperty("--font-preferred-size");
		el.style.removeProperty("--file-line-width");
		el.style.removeProperty("--reading-zoom");
		if (zoomed) {
			const cs = getComputedStyle(el.parentElement ?? el);
			const font = cs.getPropertyValue("--font-preferred-size").trim() || "var(--font-text-size)";
			const width = cs.getPropertyValue("--file-line-width").trim();
			el.style.setProperty("--font-preferred-size", `calc(${font} * ${state.zoom})`);
			if (width) el.style.setProperty("--file-line-width", `calc(${width} * ${state.zoom})`);
			el.style.setProperty("--reading-zoom", String(state.zoom));
		}
		el.toggleClass("reading-zoom-scaled", zoomed);

		if (parts.kind === "reading") {
			// Magnify: widen the page with the zoom so lines don't rewrap; pan sideways.
			const { scroller, sizer } = parts;
			const magnify = zoomed && this.settings.mode === "magnify" && state.baseWidth !== null;
			// The width is dynamic, so it goes through a CSS variable; the rest is in styles.css.
			if (magnify) {
				sizer.style.setProperty("--reading-zoom-page-width", `${(state.baseWidth ?? 0) * state.zoom}px`);
			} else {
				sizer.style.removeProperty("--reading-zoom-page-width");
			}
			scroller.toggleClass("reading-zoom-magnified", magnify);
		}
	}

	/** Gesture finished: snap near 100 % and let Obsidian re-measure the view. */
	private commit(el: HTMLElement) {
		const state = this.states.get(el);
		if (!state) return;
		if (state.zoom !== 1 && Math.abs(state.zoom - 1) < SNAP_TO_ONE) this.setZoom(el, 1);
		const view = this.findView(el);
		if (!view) return;
		if (el.matches(READING_SELECTOR)) this.remeasureReading(el, view);
		else view.onResize();
	}

	private clearEl(el: HTMLElement) {
		const state = this.states.get(el);
		if (state) {
			state.zoom = 1;
			this.applyStyles(el, state);
		}
		el.querySelector(":scope > .reading-zoom-indicator")?.remove();
		el.removeClass("reading-zoom-host", "reading-zoom-scaled");
	}

	private showIndicator(el: HTMLElement, zoom: number) {
		if (!this.settings.showIndicator) return;
		let ind = el.querySelector<HTMLElement>(":scope > .reading-zoom-indicator");
		if (!ind) {
			el.addClass("reading-zoom-host");
			ind = el.createDiv({ cls: "reading-zoom-indicator" });
		}
		const indicator = ind;
		indicator.setText(`${Math.round(zoom * 100)} %`);
		indicator.addClass("is-visible");

		const win = el.win;
		const prev = this.indicatorTimers.get(el);
		if (prev !== undefined) win.clearTimeout(prev);
		this.indicatorTimers.set(
			el,
			win.setTimeout(() => indicator.removeClass("is-visible"), 800)
		);
	}
}

const percent = (value: number) => `${Math.round(value * 100)} %`;

class ReadingZoomSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ReadingZoomPlugin) {
		super(app, plugin);
	}

	/** Declarative settings (Obsidian 1.13+): rendered by Obsidian and included in settings search. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Reading view zoom mode",
				desc:
					"Reflow: text and images grow and rewrap to the pane width, like browser zoom. " +
					"Magnify: the page grows wider and you pan sideways, like a PDF.",
				control: {
					type: "dropdown",
					key: "mode",
					options: { reflow: "Reflow", magnify: "Magnify" },
					defaultValue: DEFAULT_SETTINGS.mode,
				},
			},
			{
				name: "Zoom in editing view",
				desc: "Also pinch to zoom in Live Preview and Source mode.",
				control: { type: "toggle", key: "enableInEditing", defaultValue: DEFAULT_SETTINGS.enableInEditing },
			},
			{
				name: "Minimum zoom",
				control: {
					type: "slider",
					key: "minZoom",
					min: 0.25,
					max: 1,
					step: 0.05,
					defaultValue: DEFAULT_SETTINGS.minZoom,
					displayFormat: percent,
				},
			},
			{
				name: "Maximum zoom",
				control: {
					type: "slider",
					key: "maxZoom",
					min: 1.5,
					max: 8,
					step: 0.5,
					defaultValue: DEFAULT_SETTINGS.maxZoom,
					displayFormat: percent,
				},
			},
			{
				name: "Two-finger tap resets zoom",
				control: { type: "toggle", key: "twoFingerTapReset", defaultValue: DEFAULT_SETTINGS.twoFingerTapReset },
			},
			{
				name: "Trackpad pinch / Ctrl+scroll",
				desc: "Also zoom with a trackpad pinch or Ctrl+mouse wheel.",
				control: { type: "toggle", key: "trackpadPinch", defaultValue: DEFAULT_SETTINGS.trackpadPinch },
			},
			{
				name: "Reset zoom when opening another note",
				control: { type: "toggle", key: "resetOnFileChange", defaultValue: DEFAULT_SETTINGS.resetOnFileChange },
			},
			{
				name: "Show zoom percentage while zooming",
				control: { type: "toggle", key: "showIndicator", defaultValue: DEFAULT_SETTINGS.showIndicator },
			},
		];
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as keyof ReadingZoomSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		// Changing how or where zoom applies: start over at 100 % everywhere.
		if (key === "mode" || key === "enableInEditing") this.plugin.resetAll();
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings();
	}

	/**
	 * Fallback for Obsidian < 1.13, which ignores getSettingDefinitions().
	 * Renders the same definitions with the imperative Setting API.
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const item of this.getSettingDefinitions()) {
			if (!("control" in item) || !item.control) continue;
			const control = item.control;
			const setting = new Setting(containerEl).setName(item.name);
			if (item.desc) setting.setDesc(item.desc);
			const value = this.getControlValue(control.key);
			const save = (v: unknown) => void this.setControlValue(control.key, v);
			switch (control.type) {
				case "toggle":
					setting.addToggle((t) => t.setValue(value as boolean).onChange(save));
					break;
				case "dropdown":
					setting.addDropdown((d) => d.addOptions(control.options).setValue(value as string).onChange(save));
					break;
				case "slider":
					setting.addSlider((s) =>
						s.setLimits(control.min, control.max, control.step).setValue(value as number).onChange(save)
					);
					break;
			}
		}
	}
}
