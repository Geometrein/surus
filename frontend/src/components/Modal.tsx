import type { ReactNode } from "react";

interface ModalProps {
  /** Rendered inside the header area */
  title?: ReactNode;
  /** Modal body content */
  children: ReactNode;
  /** Called when the backdrop or Escape is pressed */
  onClose: () => void;
  /** Optional footer buttons / actions */
  footer?: ReactNode;
}

/**
 * Shared modal primitive — fixed inset-0 overlay with a centred card.
 * Clicking the backdrop calls `onClose`; inner clicks are stopped.
 */
export function Modal({ title, children, onClose, footer }: ModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-raised border border-line rounded-lg p-5 shadow-xl w-80"
        onClick={(e) => e.stopPropagation()}
      >
        {title && <p className="text-sm text-body mb-3">{title}</p>}
        {children}
        {footer && <div className="flex justify-end gap-2 mt-4">{footer}</div>}
      </div>
    </div>
  );
}
