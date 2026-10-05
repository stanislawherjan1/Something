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
      <div className="menu-label">
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
      className="menu-item"
    >
      <Icon className="size-4 text-muted-foreground/65 shrink-0" strokeWidth={1.75} />
      <span className="flex-1">{label}</span>
      {active && <Check className="size-3.5 text-foreground/85 shrink-0" strokeWidth={2.25} />}
    </button>
  );
}
