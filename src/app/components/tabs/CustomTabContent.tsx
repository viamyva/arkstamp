/**
 * CustomTabContent — thin dispatcher
 *
 * Each template lives in its own file. This module re-exports
 * the shared types and routes the `template` prop to the correct component.
 */

import { TodoContent }         from './TodoTab';
import { NotesContent }        from './NotesTab';
import { ContactsContent }     from './ContactsTabContent';
import { TimelineContent }     from './TimelineTabContent';
import { DocsContent }         from './DocsTabContent';
import { ItineraryContent }    from './ItineraryTabContent';
import { BudgetContent }       from './BudgetTabContent';
import { LinksContent }        from './LinksTabContent';
import { InventoryContent }    from './InventoryTabContent';
import { EventLogContent }     from './EventLogTabContent';
import { ShoppingContent }     from './ShoppingTabContent';
import { PhotosContent }       from './PhotosTab';
import { MealPlannerContent }  from './MealPlannerTabContent';

type Template =
  | 'todo' | 'notes' | 'contacts' | 'timeline' | 'docs'
  | 'itinerary' | 'budget' | 'links' | 'inventory' | 'eventlog'
  | 'shopping' | 'photos' | 'mealplanner';

export interface CustomTabContentProps {
  chapterId: string;
  tabId: string;
  template: Template;
  chapterTitle?: string;
  tabName?: string;
  ownerUid?: string;
  refreshKey?: number;
  autoFocusNote?: boolean;
}

export function CustomTabContent({
  chapterId, tabId, template, chapterTitle, tabName,
  ownerUid, refreshKey = 0, autoFocusNote = false,
}: CustomTabContentProps) {
  switch (template) {
    case 'todo':        return <TodoContent        chapterId={chapterId} tabId={tabId} chapterTitle={chapterTitle} tabName={tabName} ownerUid={ownerUid} refreshKey={refreshKey} />;
    case 'notes':       return <NotesContent       chapterId={chapterId} tabId={tabId} ownerUid={ownerUid} refreshKey={refreshKey} autoFocusNote={autoFocusNote} />;
    case 'contacts':    return <ContactsContent    chapterId={chapterId} tabId={tabId} ownerUid={ownerUid} refreshKey={refreshKey} />;
    case 'timeline':    return <TimelineContent    chapterId={chapterId} tabId={tabId} ownerUid={ownerUid} refreshKey={refreshKey} />;
    case 'docs':        return <DocsContent        chapterId={chapterId} tabId={tabId} ownerUid={ownerUid} refreshKey={refreshKey} />;
    case 'itinerary':   return <ItineraryContent   chapterId={chapterId} tabId={tabId} ownerUid={ownerUid} refreshKey={refreshKey} />;
    case 'budget':      return <BudgetContent      chapterId={chapterId} tabId={tabId} ownerUid={ownerUid} refreshKey={refreshKey} />;
    case 'links':       return <LinksContent       chapterId={chapterId} tabId={tabId} ownerUid={ownerUid} refreshKey={refreshKey} />;
    case 'inventory':   return <InventoryContent   chapterId={chapterId} tabId={tabId} ownerUid={ownerUid} refreshKey={refreshKey} />;
    case 'eventlog':    return <EventLogContent    chapterId={chapterId} tabId={tabId} ownerUid={ownerUid} refreshKey={refreshKey} />;
    case 'shopping':    return <ShoppingContent    chapterId={chapterId} tabId={tabId} ownerUid={ownerUid} refreshKey={refreshKey} />;
    case 'photos':      return <PhotosContent      chapterId={chapterId} tabId={tabId} ownerUid={ownerUid} refreshKey={refreshKey} />;
    case 'mealplanner': return <MealPlannerContent chapterId={chapterId} tabId={tabId} ownerUid={ownerUid} refreshKey={refreshKey} />;
    default:            return null;
  }
}
