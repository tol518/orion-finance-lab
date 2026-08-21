import { createRoot, type Root } from "react-dom/client";
import FinanceLabApp from "./finance-lab-app";
import styles from "./styles.css?inline";

class OrionFinanceLabElement extends HTMLElement {
  static observedAttributes = ["api-base"];
  #root: Root | null = null;
  #mount: HTMLDivElement | null = null;

  connectedCallback() {
    if (!this.shadowRoot) {
      const shadow = this.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = styles;
      this.#mount = document.createElement("div");
      shadow.append(style, this.#mount);
    }
    if (this.#mount && !this.#root) this.#root = createRoot(this.#mount);
    this.#render();
  }

  disconnectedCallback() {
    this.#root?.unmount();
    this.#root = null;
  }

  attributeChangedCallback() {
    this.#render();
  }

  #render() {
    const apiBase = this.getAttribute("api-base");
    if (this.#root && apiBase) this.#root.render(<FinanceLabApp apiBase={apiBase} />);
  }
}
if (!customElements.get("orion-finance-lab")) {
  customElements.define("orion-finance-lab", OrionFinanceLabElement);
}
