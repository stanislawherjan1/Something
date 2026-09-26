import { Sun, Moon, Monitor, Check } from 'lucide-react';
import { useTheme } from '@/context/ThemeContext';

/**
 * The "Theme" section of a menu — Light / Dark / System with a check on the
 * current one. Shared by the user menu and the chat header's theme button
 * (browser-extension panel), so both look and behave the same.
 */
export function ThemeMenuSection() {
  const { theme, setTheme } = useTheme();
  return (
    <>
      <div className="px-3 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        Theme
      </div>
      <ThemeOption icon={Sun}     label="Light"  value="light"  current={theme} onChoose={setTheme} />
      <ThemeOption icon={Moon}    label="Dark"   value="dark"   current={theme} onChoose={setTheme} />
      <ThemeOption icon={Monitor} label="System" value="system" current={theme} onChoose={setTheme} />
    </>
  );
}

function ThemeOption({ icon, label, value, current, onChoose }) {
  const Icon = icon;
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onChoose(value)}
      className="w-full flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] text-foreground/85 hover:bg-muted/40 transition-colors text-left"
    >
      <Icon className="size-4 text-muted-foreground/65 shrink-0" strokeWidth={1.75} />
      <span className="flex-1">{label}</span>
      {active && <Check className="size-3.5 text-foreground/85 shrink-0" strokeWidth={2.25} />}
    </button>
  );
}
