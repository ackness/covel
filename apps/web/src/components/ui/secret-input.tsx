import { useLayoutEffect, useRef, type InputHTMLAttributes } from "react";

type SecretInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "defaultValue"
> & { value: string };

/** React reflects controlled input values into CSS-readable attributes.
 * Keep drafts in the value property only; never pass value/defaultValue to React.
 */
export function SecretInput({ value, ...props }: SecretInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (ref.current && ref.current.value !== value) ref.current.value = value;
  }, [value]);
  return <input {...props} ref={ref} />;
}
