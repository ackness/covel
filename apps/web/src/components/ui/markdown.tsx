import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
	a: ({ href, children }) => (
		<a href={href} target="_blank" rel="noopener noreferrer">
			{children}
		</a>
	),
	pre: ({ children }) => <pre className="overflow-x-auto">{children}</pre>,
};

function NonMemoizedMarkdown({ children }: { children: string }) {
	return (
		<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
			{children}
		</ReactMarkdown>
	);
}

export const Markdown = memo(
	NonMemoizedMarkdown,
	(prev, next) => prev.children === next.children,
);
