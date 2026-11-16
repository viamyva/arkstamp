import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Settings, LogOut, X, Check, MapPin, Navigation, Loader2 } from 'lucide-react';

const AVATAR_COLORS = [
  '#0f172a', '#1e40af', '#065f46', '#7c3aed',
  '#be185d', '#0e7490', '#92400e', '#9f1239',
];

const STORAGE_KEY = 'ark-avatar-color';
export const MAP_CENTER_KEY = 'ark-map-center';

export interface MapCenter { lat: number; lng: number; label: string; }

export function getSavedMapCenter(): MapCenter | null {
  try {
    const raw = localStorage.getItem(MAP_CENTER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.lat && parsed?.lng) return parsed as MapCenter;
  } catch {}
  return null;
}

async function geocodeAddress(address: string): Promise<MapCenter | null> {
  if (!address.trim()) return null;
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address.trim())}&format=json&limit=1`,
      { headers: { 'Accept-Language': 'en', 'User-Agent': 'ARKstamp/1.0' } }
    );
    const data = await res.json();
    if (data?.[0]) {
      const { lat, lon, display_name } = data[0];
      // Shorten display_name to city/state/country only
      const parts = display_name.split(', ');
      const label = parts.slice(0, 3).join(', ');
      return { lat: parseFloat(lat), lng: parseFloat(lon), label };
    }
  } catch {}
  return null;
}

export function getAvatarColor(): string {
  return localStorage.getItem(STORAGE_KEY) || AVATAR_COLORS[0];
}

export function UserAvatar() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [avatarColor, setAvatarColor] = useState(getAvatarColor);
  const [mapInput, setMapInput] = useState('');
  const [mapSaved, setMapSaved] = useState<MapCenter | null>(getSavedMapCenter);
  const [mapSaving, setMapSaving] = useState(false);
  const [mapError, setMapError] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // Sync color changes across all mounted instances
  useEffect(() => {
    const handler = () => setAvatarColor(getAvatarColor());
    window.addEventListener('ark-avatar-changed', handler);
    return () => window.removeEventListener('ark-avatar-changed', handler);
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectColor = (color: string) => {
    localStorage.setItem(STORAGE_KEY, color);
    setAvatarColor(color);
    window.dispatchEvent(new Event('ark-avatar-changed'));
  };

  const saveMapLocation = async () => {
    if (!mapInput.trim()) return;
    setMapSaving(true);
    setMapError('');
    const result = await geocodeAddress(mapInput);
    if (result) {
      localStorage.setItem(MAP_CENTER_KEY, JSON.stringify(result));
      setMapSaved(result);
      setMapInput('');
    } else {
      setMapError('Location not found. Try a city name or full address.');
    }
    setMapSaving(false);
  };

  const useCurrentLocation = () => {
    if (!navigator.geolocation) { setMapError('Geolocation not available on this device.'); return; }
    setMapSaving(true);
    setMapError('');
    navigator.geolocation.getCurrentPosition(
      pos => {
        const result: MapCenter = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'Current location' };
        localStorage.setItem(MAP_CENTER_KEY, JSON.stringify(result));
        setMapSaved(result);
        setMapInput('');
        setMapSaving(false);
      },
      () => { setMapError('Could not get your location. Check browser permissions.'); setMapSaving(false); }
    );
  };

  const clearMapLocation = () => {
    localStorage.removeItem(MAP_CENTER_KEY);
    setMapSaved(null);
    setMapInput('');
    setMapError('');
  };

  const initial = (user?.displayName?.[0] || user?.email?.[0] || '?').toUpperCase();
  const displayName = user?.displayName || 'Your Account';
  const email = user?.email || '';

  return (
    <>
      <div className="relative" ref={ref}>
        <button
          onClick={() => setOpen(v => !v)}
          className="w-10 h-10 rounded-full text-white font-semibold text-sm flex items-center justify-center hover:opacity-80 transition-opacity select-none shadow-sm"
          style={{ backgroundColor: avatarColor }}
          aria-label="Account menu"
        >
          {initial}
        </button>

        {open && (
          <div className="absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-lg border border-slate-200 py-1 z-50">
            <div className="px-4 py-3 border-b border-slate-100">
              <p className="text-sm font-semibold text-slate-900 truncate">{displayName}</p>
              <p className="text-xs text-slate-500 truncate">{email}</p>
            </div>

            <button
              onClick={() => { setOpen(false); setShowSettings(true); }}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <Settings className="w-4 h-4" />
              Settings
            </button>

            <div className="border-t border-slate-100 mt-1" />

            <button
              onClick={() => { setOpen(false); signOut(); }}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </button>
          </div>
        )}
      </div>

      {/* Settings modal — fixed overlay, works from any page */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-[100] p-0 sm:p-5">
          <div className="bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold text-slate-900">Settings</h2>
              <button onClick={() => setShowSettings(false)} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors">
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>

            {/* Avatar preview */}
            <div className="flex items-center gap-4 mb-6">
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center text-2xl font-bold text-white shadow-sm"
                style={{ backgroundColor: avatarColor }}
              >
                {initial}
              </div>
              <div>
                <p className="font-semibold text-slate-900">{displayName}</p>
                <p className="text-sm text-slate-500 truncate max-w-[180px]">{email}</p>
              </div>
            </div>

            {/* Color picker */}
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-3">Avatar Color</p>
            <div className="flex gap-2 mb-6">
              {AVATAR_COLORS.map(color => (
                <button
                  key={color}
                  onClick={() => selectColor(color)}
                  className="w-9 h-9 rounded-full flex items-center justify-center transition-transform active:scale-95 hover:scale-110"
                  style={{ backgroundColor: color }}
                >
                  {avatarColor === color && <Check className="w-4 h-4 text-white" />}
                </button>
              ))}
            </div>

            {/* Map default location */}
            <div className="border-t border-slate-100 pt-6 mb-6">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Map Default Location</p>
              <p className="text-xs text-slate-400 mb-3">The starting center for itinerary maps before segments are plotted.</p>

              {mapSaved && (
                <div className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2.5 mb-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <MapPin className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                    <p className="text-xs text-slate-700 truncate">{mapSaved.label}</p>
                  </div>
                  <button onClick={clearMapLocation} className="ml-2 text-xs text-slate-400 hover:text-red-500 transition-colors flex-shrink-0">Clear</button>
                </div>
              )}

              <div className="flex gap-2">
                <input
                  value={mapInput}
                  onChange={e => { setMapInput(e.target.value); setMapError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') saveMapLocation(); }}
                  placeholder="City, zip, or address..."
                  className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-slate-900 transition-colors"
                />
                <button
                  onClick={saveMapLocation}
                  disabled={!mapInput.trim() || mapSaving}
                  className="px-3 py-2 bg-slate-900 text-white text-xs font-medium rounded-xl hover:bg-slate-800 disabled:opacity-30 transition-colors flex-shrink-0"
                >
                  {mapSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Set Map'}
                </button>
              </div>

              <button
                onClick={useCurrentLocation}
                disabled={mapSaving}
                className="mt-2 flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-900 transition-colors disabled:opacity-40"
              >
                <Navigation className="w-3 h-3" />
                Use my current location
              </button>

              {mapError && <p className="text-xs text-red-500 mt-2">{mapError}</p>}
            </div>

            <button
              onClick={() => { setShowSettings(false); signOut(); }}
              className="w-full px-4 py-2.5 text-sm text-red-600 border border-red-200 rounded-xl hover:bg-red-50 transition-colors font-medium"
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </>
  );
}
