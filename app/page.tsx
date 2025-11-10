'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabaseClient';
import { Auth } from '@supabase/auth-ui-react';
import { ThemeSupa } from '@supabase/auth-ui-shared';

// IndexedDB helpers (same as before)
async function get(key: string): Promise<any> {
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(key) : null;
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}
async function set(key: string, value: any): Promise<void> {
  try {
    if (typeof window !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {}
}

type Message = {
  id: number | string;
  content: string;
  created_at: string;
  isTemp?: boolean;
  synced?: boolean;
};

export default function InsertMessage() {
  const [user, setUser] = useState<any>(null);
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [fetchLoading, setFetchLoading] = useState(true);
  const [syncQueue, setSyncQueue] = useState<Message[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);


  // Auth state listener
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUser(session?.user ?? null);
      }
    );
    supabase.auth.getUser().then(({ data }) => setUser(data?.user ?? null));
    return () => subscription.unsubscribe();
  }, []);

  // Load messages from IndexedDB
  useEffect(() => {
    setHasMounted(true);
    async function loadFromIndexedDB() {
      const storedMessages = await get('messages');
      const storedQueue = await get('syncQueue');
      if (storedMessages && Array.isArray(storedMessages)) {
        setMessages(storedMessages);
      }
      if (storedQueue && Array.isArray(storedQueue)) {
        setSyncQueue(storedQueue);
      }
    }
    loadFromIndexedDB();
  }, []);

  // Fetch from Supabase only if authenticated
  useEffect(() => {
    if (user) fetchMessages();
  }, [user]);

  const fetchMessages = async () => {
    setFetchLoading(true);
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .order('created_at', { ascending: false });
      if (!error && data) {
        setMessages((prev) => {
          const tempMessages = prev.filter((m) => m.isTemp);
          const dbMessages = data.map((m) => ({ ...m, synced: true }));
          return [...tempMessages, ...dbMessages];
        });
        await set('messages', data);
      }
    } catch {}
    setFetchLoading(false);
  };

  const syncMessages = useCallback(async () => {
    if (syncQueue.length === 0 || isSyncing) return;
    setIsSyncing(true);
    const messagesToSync = [...syncQueue];
    try {
      const { data, error } = await supabase
        .from('messages')
        .insert(messagesToSync.map(({ id, isTemp, synced, ...msg }) => msg))
        .select();
      if (!error && data) {
        setMessages((prev) => prev.filter((m) => !m.isTemp));
        setSyncQueue([]);
        await set('syncQueue', []);
      }
    } catch {}
    setIsSyncing(false);
  }, [syncQueue, isSyncing]);

  useEffect(() => {
    if (!hasMounted) return;
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
    set('syncQueue', syncQueue).then(() => {
      if (syncQueue.length > 0 && !isSyncing) {
        syncTimeoutRef.current = setTimeout(() => syncMessages(), 500);
      }
    });
    return () => {
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
    };
  }, [syncQueue, hasMounted, isSyncing, syncMessages]);

  // Supabase Realtime - listen for database inserts
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel('messages-realtime-3001', {
        config: { broadcast: { self: true } },
      })
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const newMsg = payload.new as Message;
            setMessages((prev) => {
              const exists = prev.some((m) => m.id === newMsg.id);
              if (exists) return prev;
              return [{ ...newMsg, synced: true }, ...prev];
            });
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user]);

  useEffect(() => {
    if (!hasMounted) return;
    const syncedMessages = messages.filter((m) => !m.isTemp);
    set('messages', syncedMessages);
  }, [messages, hasMounted]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) {
      setError('Content is required!');
      return;
    }
    setError(null);
    const tempId = `temp-${Date.now()}`;
    const newMessage: Message = {
      id: tempId,
      content,
      created_at: new Date().toISOString(),
      isTemp: true,
      synced: false,
    };
    setMessages((prev) => [newMessage, ...prev]);
    setSyncQueue((prev) => [...prev, newMessage]);
    setContent('');
  };

  // Auth UI if not signed in
  if (!user) {
    return (
      <div style={{ maxWidth: 340, margin: 'auto', padding: 50 }}>
        <Auth
          supabaseClient={supabase}
          providers={['google', 'github']}
          appearance={{ theme: ThemeSupa }}
          theme="dark"
        />
      </div>
    );
  }

  // Main app when signed in
  return (
    <div style={{ maxWidth: 800, margin: 'auto', padding: 20 }}>
      <h1>Messages App (Authed)</h1>
      <button
        onClick={() => supabase.auth.signOut()}
        style={{
          position: 'absolute',
          right: 30,
          top: 25,
          background: '#f0f0f0',
          color: '#222',
          border: '1px solid #ccc',
          borderRadius: 4,
          padding: '7px 16px',
          fontSize: 15,
          cursor: 'pointer'
        }}
      >
        Sign out
      </button>

      {/* Add Message Form */}
      <section style={{ background: '#f5f5f5', padding: 20, borderRadius: 8, marginBottom: 30 }}>
        <h2 style={{ marginTop: 0, marginBottom: 15 }}>➕ Add New Message</h2>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Write a message (saves instantly to IndexedDB!)"
            required
            style={{
              width: '70%',
              padding: 10,
              fontSize: 16,
              border: '1px solid #ccc',
              borderRadius: 4,
            }}
          />
          <button
            type="submit"
            style={{
              padding: '10px 20px',
              marginLeft: 10,
              fontSize: 16,
              backgroundColor: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            ⚡ Add (Instant)
          </button>
        </form>
        {error && (
          <div
            style={{
              color: 'red',
              marginTop: 10,
              padding: 10,
              background: '#ffe6e6',
              borderRadius: 4,
            }}
          >
            {error}
          </div>
        )}
        <div style={{ marginTop: 15, fontSize: 13, color: '#666' }}>
          ⚡ Messages appear instantly (IndexedDB) → then sync to Supabase in background
        </div>
      </section>

      {/* Messages List */}
      <section>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 15,
        }}>
          <h2 style={{ margin: 0 }}>📋 All Messages</h2>
          <button
            onClick={fetchMessages}
            disabled={fetchLoading}
            style={{
              padding: '8px 16px',
              fontSize: 14,
              backgroundColor: '#28a745',
              color: 'white',
              border: 'none',
              borderRadius: 4,
              cursor: fetchLoading ? 'not-allowed' : 'pointer',
            }}
          >
            {fetchLoading ? 'Refreshing...' : '🔄 Refresh from DB'}
          </button>
        </div>

        {fetchLoading && messages.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#666' }}>
            Loading messages...
          </div>
        ) : messages.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: 40, color: '#666',
            background: '#f9f9f9', borderRadius: 8
          }}>
            No messages yet. Add one above! 👆
          </div>
        ) : (
          <ul style={{
            listStyle: 'none', padding: 0, margin: 0,
          }}>
            {messages.map(({ id, content, created_at }) => (
              <li
                key={id}
                style={{
                  padding: 15, marginBottom: 10,
                  borderLeft: '4px solid #007bff',
                  background: '#fff',
                  borderRadius: 4,
                  boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                }}
              >
                <div style={{ fontWeight: 500, fontSize: 16, marginBottom: 5 }}>
                  {content}
                </div>
                <div style={{ fontSize: 12, color: '#666' }}>
                  ID: {id} | Created: {new Date(created_at).toLocaleString()}
                </div>
              </li>
            ))}
          </ul>
        )}

        <div style={{
          marginTop: 20, padding: 15, background: '#e7f3ff',
          borderRadius: 4, fontSize: 14,
        }}>
          <strong>💡 How it works:</strong>
          <ul style={{ margin: '10px 0 0 0', paddingLeft: 20 }}>
            <li>Messages saved to <strong>IndexedDB first</strong> (instant, zero latency!)</li>
            <li>Background sync to <strong>Supabase</strong> (within 500ms)</li>
            <li>Realtime updates from other clients via <strong>Supabase Realtime</strong></li>
            <li>Works offline - syncs when connection restored</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
