import { useEffect } from "react";
import { currentPage, routes } from "./data/navigation.ts";
import { Dashboard } from "./components/Dashboard.tsx";
import { Examples } from "./components/Examples.tsx";
import { Overview } from "./components/Overview.tsx";

/** Three pages, one app shell: the overview, a recorded example, and the workspace. */
export default function App() {
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("view") === "challenge") {
      window.history.replaceState(null, "", routes.home);
    }
  }, []);
  const page = currentPage();
  return page === "dashboard" ? <Dashboard /> : page === "examples" ? <Examples /> : <Overview />;
}
