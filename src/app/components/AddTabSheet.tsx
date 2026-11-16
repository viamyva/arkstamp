import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { db } from '../../lib/firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import {
  X, Loader2,
  ListChecks, AlignLeft, Users, Calendar, Folder, Plane,
  DollarSign, Link2, Package, ScrollText, ShoppingCart, Image, UtensilsCrossed,
} from 'lucide-react';

type Template =
  | 'todo' | 'notes' | 'contacts' | 'timeline' | 'docs' | 'itinerary'
  | 'budget' | 'links' | 'inventory' | 'eventlog' | 'shopping' | 'photos'
  | 'mealplanner';

const TEMPLATES: {
  id: Template;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'notes',       label: 'Notes',        Icon: AlignLeft      },
  { id: 'todo',        label: 'To-do',        Icon: ListChecks     },
  { id: 'contacts',    label: 'Contacts',     Icon: Users          },
  { id: 'timeline',    label: 'Timeline',     Icon: Calendar       },
  { id: 'itinerary',   label: 'Itinerary',    Icon: Plane          },
  { id: 'budget',      label: 'Budget',       Icon: DollarSign     },
  { id: 'links',       label: 'Links',        Icon: Link2          },
  { id: 'inventory',   label: 'Inventory',    Icon: Package        },
  { id: 'eventlog',    label: 'Event Log',    Icon: ScrollText     },
  { id: 'shopping',    label: 'Shopping',     Icon: ShoppingCart   },
  { id: 'docs',        label: 'Documents',    Icon: Folder         },
  { id: 'photos',      label: 'Photos',       Icon: Image          },
  { id: 'mealplanner', label: 'Meal Planner', Icon: UtensilsCrossed },
];

interface AddTabSheetProps {
  chapterId: string;
  ownerUid?: string;
  existingTabCount: number;
  onClose: () => void;
  onTabCreated: (tabId: string) => void;
}

export function AddTabSheet({
  chapterId, ownerUid, existingTabCount, onClose, onTabCreated,
}: AddTabSheetProps) {
  const { user } = useAuth();
  const [saving, setSaving] = useState<Template | null>(null);

  const handleSelect = async (id: Template) => {
    if (!user || saving) return;
    setSaving(id);
    try {
      const tmpl = TEMPLATES.find(t => t.id === id);
      const uid = ownerUid ?? user.uid;
      const ref = await addDoc(
        collection(db, `users/${uid}/chapters/${chapterId}/customTabs`),
        {
          name: tmpl?.label ?? id,
          template: id,
          order: existingTabCount,
          createdAt: serverTimestamp(),
        }
      );
      onTabCreated(ref.id);
    } catch (err: any) {
      console.error('Failed to create tab:', err);
      setSaving(null);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white w-full max-w-sm rounded-3xl shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <h2 className="text-sm font-semibold text-slate-700">Add a tab</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-slate-100 transition-colors"
          >
            <X className="w-3.5 h-3.5 text-slate-400" />
          </button>
        </div>

        {/* Dense icon grid — iPhone-style tight spacing, 5 per row */}
        <div className="px-5 pb-6">
          <div className="grid grid-cols-5 gap-x-2 gap-y-4 justify-items-center">
            {TEMPLATES.map(({ id, label, Icon }) => {
              const isLoading = saving === id;
              return (
                <button
                  key={id}
                  onClick={() => handleSelect(id)}
                  disabled={!!saving}
                  className="flex flex-col items-center gap-1 w-[56px] rounded-xl active:scale-95 transition-all disabled:opacity-50"
                >
                  <div className="w-8 h-8 rounded-xl bg-slate-100 flex items-center justify-center flex-shrink-0">
                    {isLoading
                      ? <Loader2 className="w-3.5 h-3.5 text-slate-500 animate-spin" />
                      : <Icon className="w-3.5 h-3.5 text-slate-600" />
                    }
                  </div>
                  <span className="text-[10px] font-medium text-slate-500 leading-tight text-center">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
