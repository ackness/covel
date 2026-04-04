import React from "react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallbackMessage?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

export class MessageErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, error: undefined };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 text-red-500">
          {this.props.fallbackMessage ?? "Message rendering error"}:{" "}
          {this.state.error?.message}
        </div>
      );
    }
    return this.props.children;
  }
}
