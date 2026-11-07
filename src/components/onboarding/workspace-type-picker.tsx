import { cn } from '@/lib/utils';
import { WORKSPACE_TYPE_INFO, WORKSPACE_TYPES, type WorkspaceType } from '@/lib/workspace-type';

type Props = {
  name?: string;
  defaultValue?: WorkspaceType;
  disabled?: boolean;
  required?: boolean;
};

/** "Which Describes You?" (ONB-001, ONB-002): the five workspace types as one radio group. */
export function WorkspaceTypePicker({
  name = 'workspaceType',
  defaultValue,
  disabled,
  required,
}: Props) {
  return (
    <fieldset
      className="flex flex-col gap-0.5"
      disabled={disabled}
      data-testid="workspace-type-picker"
    >
      <legend className="mb-1.5 font-medium text-sm">Which Describes You?</legend>
      {WORKSPACE_TYPES.map((type) => {
        const info = WORKSPACE_TYPE_INFO[type];
        return (
          <label
            key={type}
            className={cn(
              'group flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2 transition-colors',
              'hover:bg-muted/60 has-[:checked]:bg-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50',
              'has-[:disabled]:cursor-default has-[:disabled]:opacity-70',
            )}
          >
            <input
              type="radio"
              name={name}
              value={type}
              defaultChecked={defaultValue === type}
              required={required}
              className="mt-1 accent-primary"
            />
            <span className="flex flex-col">
              <span className="font-medium text-sm">{info.label}</span>
              <span className="text-muted-foreground text-xs group-has-[:checked]:text-foreground/70">
                {info.description}
              </span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
