import { Badge, Input, Card, Empty, Button } from "@/components";
import { PageLayout } from "@/layouts";
import { getAllLiveSessions } from "@/lib/database";
import { resumeLiveSuggest } from "@/lib";
import type { LiveSession } from "@/types";
import { WandSparklesIcon, Search, PlayIcon } from "lucide-react";
import moment from "moment";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LiveSuggestPrompt } from "./LiveSuggestPrompt";

const LiveSuggestHistory = () => {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const result = await getAllLiveSessions();
        if (mounted) setSessions(result);
      } catch (err) {
        console.error("Failed to load Live Suggest sessions:", err);
      } finally {
        if (mounted) setIsLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const grouped = useMemo(() => {
    const filtered = sessions.filter((s) =>
      search.trim()
        ? s.title.toLowerCase().includes(search.toLowerCase())
        : true
    );
    return filtered.reduce((acc, s) => {
      const key = moment(s.updatedAt).format("YYYY-MM-DD");
      (acc[key] ||= []).push(s);
      return acc;
    }, {} as Record<string, LiveSession[]>);
  }, [sessions, search]);

  const sortedDates = Object.keys(grouped).sort((a, b) =>
    moment(b).diff(moment(a))
  );

  return (
    <PageLayout
      title="Live Suggest"
      description="Past hands-free listening sessions with transcript and suggestions"
    >
      <div className="mb-8">
        <LiveSuggestPrompt />
      </div>

      {sessions.length === 0 ? (
        <Empty
          isLoading={isLoading}
          icon={WandSparklesIcon}
          title="No Live Suggest sessions yet"
          description="Start Live Suggest from the overlay to capture a session"
        />
      ) : (
        <div className="flex flex-col gap-6 pb-8">
          <div className="relative mb-4 w-1/3">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search sessions..."
              className="pl-9 focus-visible:ring-0 focus-visible:ring-offset-0"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {sortedDates.map((dateKey) => (
            <div key={dateKey} className="flex flex-col gap-3">
              <p className="text-xs text-muted-foreground select-none font-medium">
                {moment(dateKey).format("ddd, MMM D")}
              </p>
              <div className="grid grid-cols-1 gap-3">
                {grouped[dateKey].map((s) => {
                  const transcriptCount = s.items.filter(
                    (i) => i.kind === "transcript"
                  ).length;
                  return (
                    <Card
                      key={s.id}
                      className="shadow-none select-none p-4 gap-0 group relative transition-all !bg-black/5 dark:!bg-white/5 hover:!border-primary/50 cursor-pointer"
                      onClick={() => navigate(`/live-suggest/view/${s.id}`)}
                    >
                      <div className="flex items-center justify-between">
                        <p className="line-clamp-1 text-sm mr-8">{s.title}</p>
                        <div className="flex items-center gap-1">
                          <Badge variant="outline" className="text-xs">
                            {transcriptCount} lines
                          </Badge>
                          <Badge variant="outline" className="text-xs">
                            {moment(s.updatedAt).format("hh:mm A")}
                          </Badge>
                          <Button
                            size="sm"
                            variant="outline"
                            title="Resume this session"
                            className="h-6 gap-1 px-2 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => {
                              e.stopPropagation();
                              resumeLiveSuggest(s.id);
                            }}
                          >
                            <PlayIcon className="size-3" />
                            Resume
                          </Button>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </PageLayout>
  );
};

export default LiveSuggestHistory;
