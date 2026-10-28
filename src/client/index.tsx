import { render } from "@solidjs/web";
import { App } from "./App";
import { getClient } from "./ws";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("ไม่พบ element #root");

const client = getClient();
client.connect();

// Vite replaces the module graph on hot updates; close the old socket so a
// development session does not accumulate connections.
if (import.meta.hot) {
  import.meta.hot.dispose(() => client.dispose());
}

render(() => <App />, root);
