import { useRef, useState } from "react";
import {
  Button,
  Popover,
  PopoverTrigger,
  PopoverContent,
  ScrollArea,
  Textarea,
} from "@/components";
import {
  FileTextIcon,
  ImageIcon,
  StickyNoteIcon,
  PaperclipIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CONTEXT_FILE_ACCEPT } from "@/hooks/useLiveSuggest";
import type { LiveContextItem } from "@/types";

interface LiveContextProps {
  context: LiveContextItem[];
  supportsImages: boolean;
  onAddText: (text: string) => void;
  onAddFiles: (files: FileList | File[]) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}

const KindIcon = ({ kind }: { kind: LiveContextItem["kind"] }) => {
  if (kind === "image") return <ImageIcon className="h-3 w-3" />;
  if (kind === "file") return <FileTextIcon className="h-3 w-3" />;
  return <StickyNoteIcon className="h-3 w-3" />;
};

// Compact context manager shown in the Live Suggest overlay header. Lets the
// user attach background material (typed notes, text files, images) that grounds
// the model's suggestions for the current session.
export const LiveContext = ({
  context,
  supportsImages,
  onAddText,
  onAddFiles,
  onRemove,
  onClear,
}: LiveContextProps) => {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const count = context.length;

  const handleAddNote = () => {
    const clean = note.trim();
    if (!clean) return;
    onAddText(clean);
    setNote("");
  };

  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onAddFiles(e.target.files);
    }
    // Reset so the same file can be picked again.
    e.target.value = "";
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant={count > 0 ? "secondary" : "ghost"}
          className="h-6 gap-1 rounded-md px-2 text-[10px]"
          title="Add background context for this session"
        >
          <PaperclipIcon className="h-3 w-3" />
          Context
          {count > 0 && (
            <span className="ml-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground">
              {count}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        className="w-80 p-3 border-input/50"
      >
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold">Session context</p>
            {count > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1.5 text-[10px] text-muted-foreground"
                onClick={onClear}
              >
                Clear all
              </Button>
            )}
          </div>
          <p className="text-[10px] leading-snug text-muted-foreground">
            Attach notes, documents, or images. Suggestions will be grounded in
            this material. It stays with this session.
          </p>

          {/* Typed note */}
          <div className="space-y-1.5">
            <Textarea
              placeholder="Type or paste context (agenda, job description, notes…)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  handleAddNote();
                }
              }}
              className="min-h-16 resize-none text-xs"
            />
            <div className="flex items-center justify-between gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={CONTEXT_FILE_ACCEPT}
                className="hidden"
                onChange={handleFiles}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-[10px]"
                onClick={() => fileInputRef.current?.click()}
                title={
                  supportsImages
                    ? "Attach text files or images"
                    : "Attach text files (current model doesn't support images)"
                }
              >
                <PaperclipIcon className="h-3 w-3" />
                Attach file
              </Button>
              <Button
                size="sm"
                className="h-7 gap-1 px-2 text-[10px]"
                onClick={handleAddNote}
                disabled={!note.trim()}
              >
                <PlusIcon className="h-3 w-3" />
                Add note
              </Button>
            </div>
            {!supportsImages && (
              <p className="text-[9px] text-muted-foreground">
                Images need a vision-capable model. Text files always work.
              </p>
            )}
          </div>

          {/* Attached items */}
          {count > 0 && (
            <ScrollArea className="max-h-44">
              <div className="space-y-1.5 pr-1">
                {context.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 p-1.5"
                  >
                    {item.kind === "image" && item.imageBase64 ? (
                      <img
                        src={`data:${item.mimeType || "image/png"};base64,${
                          item.imageBase64
                        }`}
                        alt={item.name}
                        className="h-8 w-8 flex-shrink-0 rounded object-cover"
                      />
                    ) : (
                      <span className="mt-0.5 flex-shrink-0 text-muted-foreground">
                        <KindIcon kind={item.kind} />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] font-medium">
                        {item.name}
                      </p>
                      <p className="truncate text-[9px] text-muted-foreground">
                        {item.kind === "image"
                          ? "Image"
                          : item.kind === "file"
                          ? `File · ${item.text?.length ?? 0} chars`
                          : `Note · ${item.text?.length ?? 0} chars`}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemove(item.id)}
                      className={cn(
                        "flex-shrink-0 rounded p-0.5 text-muted-foreground",
                        "hover:bg-destructive/10 hover:text-destructive"
                      )}
                      title="Remove"
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
