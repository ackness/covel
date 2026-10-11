import { createFileRoute, redirect } from "@tanstack/react-router";

// The app opens on the world list, which is its start screen: it continues the
// last session, creates worlds and sets up models. The showcase page lives in
// `apps/site` and is not part of the app.
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/session", replace: true });
  },
});
