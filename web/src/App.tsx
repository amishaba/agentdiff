import { useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./data/queries.ts";
import { currentPage, routes } from "./data/navigation.ts";
import { Dashboard } from "./components/Dashboard.tsx";
import { Examples } from "./components/Examples.tsx";
import { Overview } from "./components/Overview.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";

/** Three pages, one app shell: the overview, a recorded example, and the workspace. */
export default function App() {
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("view") === "challenge") {
      window.history.replaceState(null, "", routes.home);
    }
  }, []);
  const page = currentPage();
  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary label="This page">
        {page === "dashboard" ? <Dashboard /> : page === "examples" ? <Examples /> : <Overview />}
      </ErrorBoundary>
    </QueryClientProvider>
  );
}
