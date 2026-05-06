import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { BlockSchemaDeclaration } from "@covel/shared";

export interface SchemaBlockRendererProps {
	schema: BlockSchemaDeclaration;
	data: Record<string, unknown>;
	onSubmit: (value: string) => void;
	disabled?: boolean;
}

export function SchemaBlockRenderer({
	schema,
	data,
	onSubmit,
	disabled,
}: SchemaBlockRendererProps) {
	const [formValues, setFormValues] = useState<Record<string, unknown>>({});

	if (schema.interactive && schema.submitSchema) {
		return (
			<InteractiveSchemaBlock
				schema={schema}
				data={data}
				formValues={formValues}
				setFormValues={setFormValues}
				onSubmit={onSubmit}
				disabled={disabled}
			/>
		);
	}

	return <DisplaySchemaBlock schema={schema} data={data} />;
}

// ── Display (read-only) ───────────────────────────────────────────

function DisplaySchemaBlock({
	schema,
	data,
}: {
	schema: BlockSchemaDeclaration;
	data: Record<string, unknown>;
}) {
	const properties = (schema.dataSchema.properties ?? {}) as Record<
		string,
		Record<string, unknown>
	>;

	return (
		<Card className="max-w-md">
			<CardHeader className="py-3 px-4 border-b border-border">
				<CardTitle className="text-sm">
					{resolveDisplayName(schema.meta.displayName ?? "")}
				</CardTitle>
			</CardHeader>
			<CardContent className="p-4 space-y-3">
				{Object.entries(properties).map(([key, propSchema]) =>
					renderDisplayField(key, propSchema, data[key]),
				)}
			</CardContent>
		</Card>
	);
}

function renderDisplayField(
	key: string,
	propSchema: Record<string, unknown>,
	value: unknown,
): React.ReactNode {
	if (value === undefined || value === null) return null;

	const type = propSchema.type as string;

	if (type === "string") {
		return (
			<div key={key} className="space-y-1">
				<p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					{key}
				</p>
				<p className="text-sm">{String(value)}</p>
			</div>
		);
	}

	if (type === "number" || type === "integer") {
		return (
			<div key={key} className="space-y-1">
				<p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					{key}
				</p>
				<p className="text-sm font-mono">{String(value)}</p>
			</div>
		);
	}

	if (type === "boolean") {
		return (
			<div key={key} className="flex items-center gap-2">
				<p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					{key}
				</p>
				<span className="text-xs px-1.5 py-0.5 border border-border bg-muted/30">
					{value ? "Yes" : "No"}
				</span>
			</div>
		);
	}

	if (type === "array" && Array.isArray(value)) {
		const itemSchema = (propSchema.items ?? {}) as Record<string, unknown>;
		return (
			<div key={key} className="space-y-2">
				<p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					{key}
				</p>
				<div className="space-y-1.5">
					{/* Items lack stable IDs; index key is acceptable for static display */}
					{value.map((item, i) => (
						<div key={i} className="border border-border p-2 text-sm">
							{typeof item === "object" && item !== null
								? renderObjectFields(
										item as Record<string, unknown>,
										itemSchema,
									)
								: String(item)}
						</div>
					))}
				</div>
			</div>
		);
	}

	if (type === "object" && typeof value === "object") {
		return (
			<div key={key} className="space-y-1">
				<p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					{key}
				</p>
				<div className="border border-border p-2">
					{renderObjectFields(value as Record<string, unknown>, propSchema)}
				</div>
			</div>
		);
	}

	return (
		<div key={key} className="space-y-1">
			<p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
				{key}
			</p>
			<p className="text-sm font-mono text-muted-foreground">
				{JSON.stringify(value)}
			</p>
		</div>
	);
}

function renderObjectFields(
	obj: Record<string, unknown>,
	schema: Record<string, unknown>,
) {
	const props = (schema.properties ?? {}) as Record<
		string,
		Record<string, unknown>
	>;
	const keys =
		Object.keys(props).length > 0 ? Object.keys(props) : Object.keys(obj);
	return (
		<div className="space-y-1.5">
			{keys.map((k) => {
				const val = obj[k];
				if (val === undefined || val === null) return null;
				return (
					<div key={k} className="flex gap-2 text-sm">
						<span className="text-muted-foreground shrink-0">{k}:</span>
						<span>
							{typeof val === "object" ? JSON.stringify(val) : String(val)}
						</span>
					</div>
				);
			})}
		</div>
	);
}

// ── Interactive (form) ────────────────────────────────────────────

function InteractiveSchemaBlock({
	schema,
	data,
	formValues,
	setFormValues,
	onSubmit,
	disabled,
}: {
	schema: BlockSchemaDeclaration;
	data: Record<string, unknown>;
	formValues: Record<string, unknown>;
	setFormValues: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
	onSubmit: (value: string) => void;
	disabled?: boolean;
}) {
	const properties = (schema.dataSchema.properties ?? {}) as Record<
		string,
		Record<string, unknown>
	>;

	const title = data.title as string | undefined;
	const description = data.description as string | undefined;

	const handleFieldChange = (key: string, value: unknown) => {
		setFormValues((prev) => ({ ...prev, [key]: value }));
	};

	const handleSubmit = () => {
		const result = Object.keys(formValues).length > 0 ? formValues : data;
		onSubmit(JSON.stringify(result));
	};

	// Render interactive fields from data's array-type fields
	const arrayFields = Object.entries(properties).filter(
		([, ps]) => ps.type === "array",
	);

	return (
		<Card className="max-w-md">
			<CardHeader className="py-3 px-4 border-b border-border space-y-1">
				<CardTitle className="text-sm">
					{title ?? resolveDisplayName(schema.meta.displayName ?? "")}
				</CardTitle>
				{description && (
					<p className="text-xs text-muted-foreground">{description}</p>
				)}
			</CardHeader>
			<CardContent className="p-4 space-y-4">
				{/* Render simple string/number fields from data */}
				{Object.entries(properties).map(([key, propSchema]) => {
					if (propSchema.type === "array") return null;
					const value = data[key];
					if (value === undefined || value === null) return null;
					return renderDisplayField(key, propSchema, value);
				})}

				{/* Render interactive form fields from array data */}
				{arrayFields.map(([key, propSchema]) => {
					const items = data[key] as Array<Record<string, unknown>> | undefined;
					if (!items || !Array.isArray(items)) return null;
					const itemSchema = (propSchema.items ?? {}) as Record<
						string,
						unknown
					>;

					return (
						<div key={key} className="space-y-3">
							{items.map((item, idx) => {
								const fieldKey =
									(item.key as string) ?? (item.id as string) ?? String(idx);
								const label = (item.label as string) ?? fieldKey;
								const fieldType = (item.type as string) ?? "text";
								const placeholder = item.placeholder as string | undefined;
								const options = item.options as string[] | undefined;
								const required = item.required as boolean | undefined;

								return (
									<div key={fieldKey} className="space-y-1.5">
										<label
											htmlFor={`schema-field-${fieldKey}`}
											className="text-xs font-medium uppercase tracking-wider"
										>
											{label}
											{required && (
												<span className="text-destructive ml-0.5">*</span>
											)}
										</label>
										{renderFormInput({
											id: `schema-field-${fieldKey}`,
											fieldType,
											placeholder,
											options,
											value: formValues[fieldKey] as string | undefined,
											onChange: (v) => handleFieldChange(fieldKey, v),
											disabled,
										})}
									</div>
								);
							})}
						</div>
					);
				})}

				<Button
					className="w-full rounded-none uppercase tracking-widest text-xs font-semibold"
					disabled={disabled}
					onClick={handleSubmit}
				>
					Submit
				</Button>
			</CardContent>
		</Card>
	);
}

function renderFormInput({
	id,
	fieldType,
	placeholder,
	options,
	value,
	onChange,
	disabled,
}: {
	id: string;
	fieldType: string;
	placeholder?: string;
	options?: string[];
	value?: string;
	onChange: (value: string) => void;
	disabled?: boolean;
}) {
	const baseClass =
		"w-full bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary transition-all disabled:opacity-50";

	if (fieldType === "select" && options) {
		return (
			<select
				id={id}
				className={baseClass}
				value={value ?? ""}
				onChange={(e) => onChange(e.target.value)}
				disabled={disabled}
			>
				<option value="">{placeholder ?? "Select..."}</option>
				{options.map((opt) => (
					<option key={opt} value={opt}>
						{opt}
					</option>
				))}
			</select>
		);
	}

	if (fieldType === "textarea") {
		return (
			<textarea
				id={id}
				className={`${baseClass} min-h-[80px] resize-y`}
				placeholder={placeholder}
				value={value ?? ""}
				onChange={(e) => onChange(e.target.value)}
				disabled={disabled}
			/>
		);
	}

	if (fieldType === "number") {
		return (
			<input
				id={id}
				type="number"
				className={baseClass}
				placeholder={placeholder}
				value={value ?? ""}
				onChange={(e) => onChange(e.target.value)}
				disabled={disabled}
			/>
		);
	}

	return (
		<input
			id={id}
			type="text"
			className={baseClass}
			placeholder={placeholder}
			value={value ?? ""}
			onChange={(e) => onChange(e.target.value)}
			disabled={disabled}
		/>
	);
}

// ── Helpers ───────────────────────────────────────────────────────

function resolveDisplayName(name: string | Record<string, string>): string {
	if (typeof name === "string") return name;
	return name["zh-CN"] ?? name["en-US"] ?? Object.values(name)[0] ?? "";
}
