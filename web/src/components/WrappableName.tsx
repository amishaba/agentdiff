import { Fragment } from "react";

/**
 * A test name for a table cell: a long snake_case name can wrap after an
 * underscore instead of mid-word. `<wbr>` only offers a break, so a name
 * copied out of the table is the name as written.
 */
export function WrappableName({ name }: { name: string }) {
  const parts = name.split("_");
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && (
            <>
              _<wbr />
            </>
          )}
        </Fragment>
      ))}
    </>
  );
}
