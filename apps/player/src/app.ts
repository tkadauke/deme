import type { EntityId } from "@deme/content-schema";
import {
  DEFAULT_SAVE_KEY,
  DEFAULT_VERB,
  GameSession,
  InventoryBar,
  MemoryStorage,
  setLuaWasmUri,
  VERBS,
  type StorageLike,
  type Verb,
} from "@deme/engine";
import { Application, Container, Graphics } from "pixi.js";
// play.html's CSP has no 'unsafe-eval' (see apps/player/README.md) —
// without this, PixiJS's default renderer throws at init, since its fast
// uniform/shader-sync path is built with `new Function`. This swaps in
// PixiJS's own CSP-safe polyfills instead; must run before any renderer is
// created.
import "pixi.js/unsafe-eval";
// wasmoon needs an explicit, bundler-resolved URL for its glue.wasm in a
// browser — see setLuaWasmUri's doc comment in @deme/engine/lua-sandbox.ts.
import wasmUrl from "wasmoon/dist/glue.wasm?url";
import { DEMO_START_ROOM_ID, demoContentLoaders, loadDemoTexture } from "./content.js";

setLuaWasmUri(wasmUrl);

const ROOM_WIDTH = 800;
const ROOM_HEIGHT = 580;
const UI_STRIP_HEIGHT = 64;
const CANVAS_HEIGHT = ROOM_HEIGHT + UI_STRIP_HEIGHT;

const VERB_LABELS: Record<Verb, string> = {
  look: "Look",
  use: "Use",
  talk: "Talk",
  "pick-up": "Pick Up",
};

/**
 * Save/load storage for the demo. `play.html` is deliberately loaded into an
 * iframe with `sandbox="allow-scripts"` and no `allow-same-origin` (see
 * apps/player/README.md), which gives it a unique opaque origin on every
 * load — and opaque origins can't access `localStorage` at all (browsers
 * throw a SecurityError). `MemoryStorage` (from @deme/engine, otherwise used
 * for tests) is the correct storage backend here, not a stand-in for one:
 * save/load works for the lifetime of this page load, which is what the
 * isolation this app exists for allows.
 */
const storage: StorageLike = new MemoryStorage();

export interface Shell {
  canvasHost: HTMLDivElement;
  verbButtons: Map<Verb, HTMLButtonElement>;
  saveButton: HTMLButtonElement;
  loadButton: HTMLButtonElement;
  messageToast: HTMLDivElement;
  dialogueBox: HTMLDivElement;
  dialogueLine: HTMLParagraphElement;
  dialogueResponses: HTMLDivElement;
}

export function buildShell(root: HTMLElement): Shell {
  root.innerHTML = "";
  const shell = document.createElement("div");
  shell.className = "game-shell";

  const canvasHost = document.createElement("div");
  canvasHost.className = "canvas-host";

  const bars = document.createElement("div");
  bars.className = "bars";

  const verbBar = document.createElement("div");
  verbBar.className = "verb-bar";
  verbBar.setAttribute("role", "toolbar");
  verbBar.setAttribute("aria-label", "Actions");
  const verbButtons = new Map<Verb, HTMLButtonElement>();
  for (const verb of VERBS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ui-button verb-button";
    button.textContent = VERB_LABELS[verb];
    button.dataset["verb"] = verb;
    verbBar.appendChild(button);
    verbButtons.set(verb, button);
  }

  const sessionBar = document.createElement("div");
  sessionBar.className = "session-bar";
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "ui-button";
  saveButton.textContent = "Save";
  const loadButton = document.createElement("button");
  loadButton.type = "button";
  loadButton.className = "ui-button";
  loadButton.textContent = "Load";
  sessionBar.append(saveButton, loadButton);

  bars.append(verbBar, sessionBar);

  const messageToast = document.createElement("div");
  messageToast.className = "message-toast";
  messageToast.hidden = true;

  const dialogueBox = document.createElement("div");
  dialogueBox.className = "dialogue-box";
  dialogueBox.hidden = true;
  const dialogueLine = document.createElement("p");
  dialogueLine.className = "dialogue-line";
  const dialogueResponses = document.createElement("div");
  dialogueResponses.className = "dialogue-responses";
  dialogueBox.append(dialogueLine, dialogueResponses);

  shell.append(canvasHost, bars, messageToast, dialogueBox);
  root.appendChild(shell);

  return {
    canvasHost,
    verbButtons,
    saveButton,
    loadButton,
    messageToast,
    dialogueBox,
    dialogueLine,
    dialogueResponses,
  };
}

let toastTimeout: ReturnType<typeof setTimeout> | undefined;

export function showMessage(shell: Shell, text: string, isError = false): void {
  shell.messageToast.textContent = text;
  shell.messageToast.hidden = false;
  shell.messageToast.classList.toggle("is-error", isError);
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    shell.messageToast.hidden = true;
  }, 3200);
}

export function setActiveVerb(shell: Shell, verb: Verb): void {
  for (const [candidate, button] of shell.verbButtons) {
    button.classList.toggle("active", candidate === verb);
  }
}

export function renderDialogue(
  shell: Shell,
  session: GameSession,
  line: { text: string; responses: { text: string }[] },
): void {
  shell.dialogueBox.hidden = false;
  shell.dialogueLine.textContent = line.text;
  shell.dialogueResponses.innerHTML = "";
  line.responses.forEach((response, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ui-button dialogue-response";
    button.textContent = response.text;
    button.addEventListener("click", () => session.chooseDialogueResponse(index));
    shell.dialogueResponses.appendChild(button);
  });
}

export async function refreshInventoryBar(
  session: GameSession,
  inventoryBar: InventoryBar,
): Promise<void> {
  const items = await session.carriedItems();
  inventoryBar.setItems(items, session.inventory.selectedItemId);
}

export function onInventorySelect(session: GameSession, itemId: EntityId): void {
  if (session.inventory.selectedItemId === itemId) {
    session.deselectInventoryItem();
  } else {
    session.selectInventoryItem(itemId);
  }
}

/** Boots the demo game into `root`: PixiJS canvas, verb/session chrome, dialogue box, message toast. */
export async function boot(root: HTMLElement): Promise<GameSession> {
  const shell = buildShell(root);

  const app = new Application();
  await app.init({
    width: ROOM_WIDTH,
    height: CANVAS_HEIGHT,
    backgroundColor: 0x1a1420,
    antialias: false,
  });
  shell.canvasHost.appendChild(app.canvas);

  // GameRuntime.loadRoom calls `stage.removeChildren()` on every room
  // transition, so the InventoryBar lives in a sibling `uiLayer` — never
  // directly in the `stage` passed to GameSession — or it would be wiped out
  // the moment the player walks through the door script's `gotoRoom`.
  const gameLayer = new Container();
  const uiLayer = new Container();
  uiLayer.y = ROOM_HEIGHT;
  app.stage.addChild(gameLayer, uiLayer);

  const uiBackground = new Graphics()
    .rect(0, 0, ROOM_WIDTH, UI_STRIP_HEIGHT)
    .fill({ color: 0x120e17 });
  uiLayer.addChild(uiBackground);

  const inventoryBar = new InventoryBar({
    onSelect: (itemId) => onInventorySelect(session, itemId),
  });
  inventoryBar.container.x = 12;
  inventoryBar.container.y = 8;
  uiLayer.addChild(inventoryBar.container);

  const session = new GameSession({
    stage: gameLayer,
    loaders: demoContentLoaders,
    loadTexture: loadDemoTexture,
    startRoomId: DEMO_START_ROOM_ID,
    playerStart: { x: 400, y: 470 },
  });

  session.events.on("dialogue-started", (event) =>
    renderDialogue(shell, session, { text: event.node.text, responses: event.responses }),
  );
  session.events.on("dialogue-line", (event) =>
    renderDialogue(shell, session, { text: event.node.text, responses: event.responses }),
  );
  session.events.on("dialogue-ended", () => {
    shell.dialogueBox.hidden = true;
  });
  session.events.on("script-message", (event) => showMessage(shell, event.text));
  session.events.on("script-error", (event) =>
    showMessage(shell, `Script error: ${event.message}`, true),
  );
  session.events.on("item-picked-up", (event) => {
    void demoContentLoaders
      .loadItem(event.itemId)
      .then((item) => showMessage(shell, `Picked up ${item.name}.`));
  });
  session.events.on("item-added", () => void refreshInventoryBar(session, inventoryBar));
  session.events.on("item-removed", () => void refreshInventoryBar(session, inventoryBar));
  session.events.on("item-selected", () => void refreshInventoryBar(session, inventoryBar));
  session.events.on("item-deselected", () => void refreshInventoryBar(session, inventoryBar));

  for (const [verb, button] of shell.verbButtons) {
    button.addEventListener("click", () => {
      session.setVerb(verb);
      setActiveVerb(shell, verb);
    });
  }
  setActiveVerb(shell, DEFAULT_VERB);

  shell.saveButton.addEventListener("click", () => {
    session.save(storage);
    showMessage(shell, "Game saved.");
  });
  shell.loadButton.addEventListener("click", () => {
    if (storage.getItem(DEFAULT_SAVE_KEY) === null) {
      showMessage(shell, "No saved game yet.", true);
      return;
    }
    void session.load(storage).then(() => {
      shell.dialogueBox.hidden = true;
      showMessage(shell, "Game loaded.");
      void refreshInventoryBar(session, inventoryBar);
    });
  });

  await session.start();
  await refreshInventoryBar(session, inventoryBar);

  app.ticker.add(() => session.update(app.ticker.deltaMS));

  return session;
}
