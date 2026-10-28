import { render } from "@solidjs/web";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("ไม่พบ element #root");

render(() => <App />, root);
