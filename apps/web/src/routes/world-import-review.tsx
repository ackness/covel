import { Suspense, lazy } from "react";
import { createFileRoute } from "@tanstack/react-router";

// Lazy-load the review page so its fixture + editor stay out of the main
// app chunk, same split as the /debug surface.
const ReviewPage = lazy(() =>
  import("@/features/world-import-review/components/review-page.js").then(
    (m) => ({ default: m.ReviewPage }),
  ),
);

export const Route = createFileRoute("/world-import-review")({
  component: WorldImportReviewPage,
});

function WorldImportReviewPage() {
  return (
    <Suspense fallback={null}>
      <ReviewPage />
    </Suspense>
  );
}
