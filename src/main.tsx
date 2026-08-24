import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ParityPage } from "./parity/ParityPage";
import "./index.css";

const isParity = window.location.search.includes("parity=1");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isParity ? <ParityPage /> : <App />}
  </React.StrictMode>,
);
