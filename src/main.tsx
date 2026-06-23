import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { MindSteedProvider } from "./state/MindSteedStore";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MindSteedProvider>
      <App />
    </MindSteedProvider>
  </React.StrictMode>,
);
