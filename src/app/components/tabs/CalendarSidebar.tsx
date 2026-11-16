import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Calendar } from '../ui/calendar';
import { Calendar as CalendarIcon, ExternalLink, RefreshCw, Loader2, AlertCircle, Edit2, Trash2, X, Check, Plus } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

interface GoogleEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  description?: string;
  htmlLink?: string;
  calendarId: string;
  calendarName?: string;
}

export function CalendarSidebar() {
  const { user } = useAuth();
  const [date, setDate] = useState<Date | undefined>(new Date());
  const [allEvents, setAllEvents] = useState<GoogleEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [isBackgroundSyncing, setIsBackgroundSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(() => localStorage.getItem('google_calendar_token'));

  // Editing state
  const [editingEvent, setEditingEvent] = useState<GoogleEvent | null>(null);
  const [editForm, setEditForm] = useState({ summary: '', description: '', startTime: '', endTime: '' });
  const [isSaving, setIsSaving] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  const fetchCalendarEvents = useCallback(async (token: string, isSilent = false) => {
    if (!isSilent) setLoading(true);
    else setIsBackgroundSyncing(true);
    
    setError(null);
    try {
      const listResponse = await fetch(
        'https://www.googleapis.com/calendar/v3/users/me/calendarList',
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!listResponse.ok) {
        if (listResponse.status === 401) {
          localStorage.removeItem('google_calendar_token');
          setAccessToken(null);
          throw new Error('Unauthorized - Please reconnect your calendar.');
        }
        throw new Error('Failed to fetch calendar list.');
      }

      const listData = await listResponse.json();
      const calendars = listData.items || [];

      const timeMin = new Date();
      timeMin.setDate(timeMin.getDate() - 30);
      const timeMax = new Date();
      timeMax.setDate(timeMax.getDate() + 30);

      const eventPromises = calendars.map(async (cal: any) => {
        try {
          const resp = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?timeMin=${timeMin.toISOString()}&timeMax=${timeMax.toISOString()}&singleEvents=true&orderBy=startTime`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!resp.ok) return [];
          const data = await resp.json();
          return (data.items || []).map((item: any) => ({
            ...item,
            calendarId: cal.id,
            calendarName: cal.summaryOverride || cal.summary
          }));
        } catch (e) {
          return [];
        }
      });

      const results = await Promise.all(eventPromises);
      const mergedEvents = results.flat();
      
      mergedEvents.sort((a, b) => {
        const aTime = new Date(a.start.dateTime || a.start.date || 0).getTime();
        const bTime = new Date(b.start.dateTime || b.start.date || 0).getTime();
        return aTime - bTime;
      });

      setAllEvents(mergedEvents);
    } catch (err: any) {
      if (!isSilent) setError(err.message);
    } finally {
      setLoading(false);
      setIsBackgroundSyncing(false);
    }
  }, []);

  // 1. Initial Load & Background Polling (every 60 seconds)
  useEffect(() => {
    if (accessToken) {
      fetchCalendarEvents(accessToken);
      
      const interval = setInterval(() => {
        fetchCalendarEvents(accessToken, true);
      }, 60000); // 1 minute polling
      
      return () => clearInterval(interval);
    }
  }, [accessToken, fetchCalendarEvents]);

  // 2. Refresh on Window Focus (e.g., coming back from another tab)
  useEffect(() => {
    const handleFocus = () => {
      if (accessToken && !loading && !isBackgroundSyncing) {
        fetchCalendarEvents(accessToken, true);
      }
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [accessToken, loading, isBackgroundSyncing, fetchCalendarEvents]);

  const handleConnect = async () => {
    setLoading(true);
    setError(null);
    const CLIENT_ID = '534822744743-kjs6rgiucol4810jrkr2lqap656jopki.apps.googleusercontent.com';
    const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar';

    try {
      const width = 500;
      const height = 600;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      const redirectUri = window.location.origin.includes('localhost') ? 'http://localhost:5173/index.html' : 'https://arkstamp.com/index.html';
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent(SCOPES)}&prompt=select_account`;
      const popup = window.open(authUrl, 'google-calendar-auth', `width=${width},height=${height},left=${left},top=${top}`);

      if (!popup) throw new Error('Popup blocked!');

      const pollTimer = setInterval(() => {
        try {
          if (popup.closed) { clearInterval(pollTimer); setLoading(false); return; }
          if (popup.location.origin === window.location.origin) {
            const hash = popup.location.hash;
            if (hash) {
              const params = new URLSearchParams(hash.substring(1));
              const token = params.get('access_token');
              if (token) {
                localStorage.setItem('google_calendar_token', token);
                setAccessToken(token);
                fetchCalendarEvents(token);
                popup.close();
                clearInterval(pollTimer);
              }
            }
          }
        } catch (e) {}
      }, 500);
    } catch (err: any) {
      setError('Connection failed: ' + err.message);
      setLoading(false);
    }
  };

  const startEdit = (event: GoogleEvent) => {
    setEditingEvent(event);
    const start = event.start.dateTime ? new Date(event.start.dateTime).toISOString().slice(0, 16) : '';
    const end = event.end.dateTime ? new Date(event.end.dateTime).toISOString().slice(0, 16) : '';
    setEditForm({
      summary: event.summary,
      description: event.description || '',
      startTime: start,
      endTime: end
    });
    setIsAdding(false);
  };

  const startAdd = () => {
    setIsAdding(true);
    setEditingEvent(null);
    const now = date ? new Date(date) : new Date();
    now.setHours(new Date().getHours() + 1, 0, 0, 0);
    const start = now.toISOString().slice(0, 16);
    now.setHours(now.getHours() + 1);
    const end = now.toISOString().slice(0, 16);
    setEditForm({ summary: '', description: '', startTime: start, endTime: end });
  };

  const handleSave = async () => {
    if (!accessToken) return;
    setIsSaving(true);
    try {
      const url = editingEvent 
        ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(editingEvent.calendarId)}/events/${editingEvent.id}`
        : `https://www.googleapis.com/calendar/v3/calendars/primary/events`;
      
      const method = editingEvent ? 'PATCH' : 'POST';
      
      const body = {
        summary: editForm.summary,
        description: editForm.description,
        start: { dateTime: new Date(editForm.startTime).toISOString() },
        end: { dateTime: new Date(editForm.endTime).toISOString() }
      };

      const response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!response.ok) throw new Error('Failed to save event.');
      
      setEditingEvent(null);
      setIsAdding(false);
      fetchCalendarEvents(accessToken);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (event: GoogleEvent) => {
    if (!accessToken || !confirm('Are you sure you want to delete this event?')) return;
    try {
      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(event.calendarId)}/events/${event.id}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!response.ok) throw new Error('Failed to delete event.');
      fetchCalendarEvents(accessToken);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const filteredEvents = useMemo(() => {
    if (!date) return [];
    return allEvents.filter(event => {
      const eventStart = event.start.dateTime || event.start.date;
      if (!eventStart) return false;
      const eventDate = new Date(eventStart);
      if (!event.start.dateTime && event.start.date) {
        const [y, m, d] = event.start.date.split('-').map(Number);
        return y === date.getFullYear() && (m - 1) === date.getMonth() && d === date.getDate();
      }
      return eventDate.getFullYear() === date.getFullYear() && eventDate.getMonth() === date.getMonth() && eventDate.getDate() === date.getDate();
    });
  }, [date, allEvents]);

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
        <Calendar mode="single" selected={date} onSelect={setDate} className="rounded-md" />
      </div>

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <CalendarIcon className="w-4 h-4 text-blue-500" />
            <h3 className="text-sm font-semibold text-slate-900">Google Calendar</h3>
            {isBackgroundSyncing && <Loader2 className="w-3 h-3 text-slate-300 animate-spin" />}
          </div>
          {accessToken && (
            <div className="flex items-center gap-1">
              <button onClick={startAdd} className="p-1 hover:bg-slate-100 rounded-lg transition-colors"><Plus className="w-3.5 h-3.5 text-slate-400" /></button>
              <button onClick={() => fetchCalendarEvents(accessToken)} disabled={loading} className="p-1 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-30">
                <RefreshCw className={`w-3.5 h-3.5 text-slate-400 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          )}
        </div>

        {error && <div className="mb-4 p-3 bg-red-50 border border-red-100 rounded-xl flex items-start gap-2"><AlertCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0" /><p className="text-[10px] text-red-600 leading-tight">{error}</p></div>}

        {!accessToken ? (
          <div className="text-center py-4">
            <p className="text-xs text-slate-500 mb-4 leading-relaxed">Connect a Google Calendar account to manage events.</p>
            <button onClick={handleConnect} disabled={loading} className="w-full py-2 px-4 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-700 hover:border-slate-900 hover:text-slate-900 transition-all shadow-sm flex items-center justify-center gap-2 disabled:opacity-50">
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <img src="https://www.google.com/favicon.ico" className="w-3 h-3" alt="Google" />}
              {loading ? 'Opening...' : 'Connect Google Calendar'}
            </button>
          </div>
        ) : (editingEvent || isAdding) ? (
          <div className="space-y-3 bg-slate-50 p-4 rounded-xl border border-slate-100">
            <div className="flex items-center justify-between mb-1">
              <p className="text-[10px] font-bold text-slate-500 uppercase">{isAdding ? 'New Event' : 'Edit Event'}</p>
              <button onClick={() => { setEditingEvent(null); setIsAdding(false); }}><X className="w-3.5 h-3.5 text-slate-400" /></button>
            </div>
            <input placeholder="Event Title" value={editForm.summary} onChange={e => setEditForm({...editForm, summary: e.target.value})} className="w-full px-2 py-1.5 text-xs rounded border border-slate-200 focus:outline-none focus:border-blue-500" />
            <textarea placeholder="Notes" value={editForm.description} onChange={e => setEditForm({...editForm, description: e.target.value})} rows={3} className="w-full px-2 py-1.5 text-xs rounded border border-slate-200 focus:outline-none focus:border-blue-500 resize-none" />
            <div className="grid grid-cols-2 gap-2">
              <div><p className="text-[9px] text-slate-400 mb-0.5 ml-1">Start</p><input type="datetime-local" value={editForm.startTime} onChange={e => setEditForm({...editForm, startTime: e.target.value})} className="w-full px-1.5 py-1 text-[10px] rounded border border-slate-200" /></div>
              <div><p className="text-[9px] text-slate-400 mb-0.5 ml-1">End</p><input type="datetime-local" value={editForm.endTime} onChange={e => setEditForm({...editForm, endTime: e.target.value})} className="w-full px-1.5 py-1 text-[10px] rounded border border-slate-200" /></div>
            </div>
            <button onClick={handleSave} disabled={isSaving || !editForm.summary} className="w-full py-2 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {isSaving ? 'Saving...' : 'Save to Google'}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{date ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Events'}</p>
                <button onClick={() => { localStorage.removeItem('google_calendar_token'); setAccessToken(null); setAllEvents([]); }} className="text-[10px] text-slate-400 hover:text-red-500 transition-colors">Disconnect</button>
              </div>
              {loading && <div className="flex justify-center py-4"><Loader2 className="w-4 h-4 text-slate-300 animate-spin" /></div>}
              {!loading && filteredEvents.length === 0 && <p className="text-[11px] text-slate-400 italic py-2">No events scheduled.</p>}
              {!loading && filteredEvents.map(event => (
                <div key={event.id} className="group border-b border-slate-50 last:border-0 pb-3 last:pb-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0" onClick={() => startEdit(event)} style={{ cursor: 'pointer' }}>
                      <p className="text-xs font-semibold text-slate-900 group-hover:text-blue-600 transition-colors">{event.summary}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <p className="text-[10px] text-slate-400">{event.start.dateTime ? new Date(event.start.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'All day'}</p>
                        <span className="text-[9px] px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded-full font-medium">{event.calendarName}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => handleDelete(event)} className="p-1 hover:bg-red-50 rounded transition-colors"><Trash2 className="w-3 h-3 text-red-400" /></button>
                      <a href={event.htmlLink} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-3 h-3 text-slate-300 hover:text-slate-600" /></a>
                    </div>
                  </div>
                  {event.description && <div className="mt-1.5 p-2 bg-slate-50 rounded-lg" onClick={() => startEdit(event)} style={{ cursor: 'pointer' }}><p className="text-[10px] text-slate-500 leading-relaxed whitespace-pre-wrap">{event.description}</p></div>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
