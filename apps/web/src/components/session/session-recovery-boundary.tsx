import { Suspense, type ComponentProps, type ReactNode } from "react";
import { ExecutionRecoveryNotice } from "./execution-recovery-notice.js";

/** Recovery is host chrome and must not wait for the game surface's chunks. */
export function SessionRecoveryBoundary({
  children,
  loading,
  ...recoveryProps
}: ComponentProps<typeof ExecutionRecoveryNotice> & {
  children: ReactNode;
  loading: ReactNode;
}) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full min-h-0 flex-col">
          <ExecutionRecoveryNotice {...recoveryProps} />
          {loading}
        </div>
      }
    >
      {children}
    </Suspense>
  );
}
