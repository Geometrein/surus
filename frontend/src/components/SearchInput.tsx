import { Search, X } from "lucide-react";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

/**
 * Consistent search input: Search icon · text field · X clear button.
 * Renders as a border-bottom strip (no outer card — matches existing usage sites).
 */
export function SearchInput({ value, onChange, placeholder = "Search", autoFocus }: SearchInputProps) {
  return (
    <div className="border-b border-[#2c2c33] px-2 py-1 flex items-center gap-1.5 shrink-0">
      <Search size={13} className="text-[#6a6a72] shrink-0" />
      <input
        autoFocus={autoFocus}
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 bg-transparent text-[13px] text-white placeholder:text-[#4a4a52] outline-none"
      />
      {value && (
        <button
          className="text-[#6a6a72] hover:text-white flex items-center"
          onClick={() => onChange("")}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}
