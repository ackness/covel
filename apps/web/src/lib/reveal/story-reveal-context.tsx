import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  createStoryRevealVisit,
  registerStoryRevealVisit,
  storyRevision,
  type CommittedStory,
  type StoryRevealVisit,
} from "./committed-stories.js";
const StoryRevealContext = createContext<StoryRevealVisit | null>(null);
const emptySubscribe = () => () => {};
const emptySnapshot = () => "";
export function StoryRevealProvider({
  sessionId,
  messages,
  children,
}: {
  sessionId: string;
  messages: readonly CommittedStory[];
  children: ReactNode;
}) {
  const visit = useMemo(() => createStoryRevealVisit(messages), [sessionId]);
  useLayoutEffect(
    () => registerStoryRevealVisit(sessionId, visit),
    [sessionId, visit],
  );
  useLayoutEffect(() => visit.afterRender(messages), [visit, messages]);
  return <StoryRevealContext value={visit}>{children}</StoryRevealContext>;
}
export function useStoryReveal(message: CommittedStory) {
  const visit = useContext(StoryRevealContext);
  const latest = useSyncExternalStore(
    visit?.subscribe ?? emptySubscribe,
    visit?.snapshot ?? emptySnapshot,
    emptySnapshot,
  );
  const revision = useMemo(
    () => storyRevision(message),
    [message.id, message.content, message.segments],
  );
  const live = visit?.eligible(revision) ?? false;
  useLayoutEffect(() => {
    visit?.claim(revision);
  }, [visit, revision]);
  return { revision, live, active: !latest || latest === revision };
}
