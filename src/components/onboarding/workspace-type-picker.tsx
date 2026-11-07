import { cn } from '@/lib/utils';
import { WORKSPACE_TYPE_INFO, WORKSPACE_TYPES, type WorkspaceType } from '@/lib/workspace-type';

type Props = {
  name?: string;
  defaultValue?: WorkspaceType;
  disabled?: boolean;
  required?: boolean;
};

/** "Which describes you?" (ONB-001, ONB-002): the five workspace types as one radio group. */
export function WorkspaceTypePicker({
  name = 'workspaceType',
  defaultValue,
  disabled,
  required,
}: Props) {
  return (
    <fieldset
      className="flex flex-col gap-2"
      disabled={disabled}
      data-testid="workspace-type-picker"
    >
      <legend className="mb-1.5 font-medium text-sm">Which describes you?</legend>
      {WORKSPACE_TYPES.map((type) => {
        const info = WORKSPACE_TYPE_INFO[type];
        return (
          <label
            key={type}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg bg-muted/50 px-3 py-2.5 transition-colors',
              'hover:bg-muted has-[:checked]:bg-primary/10 has-[:checked]:ring-1 has-[:checked]:ring-primary/40',
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
              <span className="text-muted-foreground text-xs">{info.description}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
