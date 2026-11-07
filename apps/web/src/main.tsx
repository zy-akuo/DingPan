import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import App from "./App";
import { installRequestFeedback } from "./lib/requestFeedback";
import { applyThemeToDom, loadTheme } from "./lib/theme";
import "./index.css";

installRequestFeedback();
dayjs.locale("zh-cn");
applyThemeToDom(loadTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
