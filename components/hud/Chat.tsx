'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatMessage } from '@/lib/game/match';

export function Chat({ messages, you, onSend }: { messages: ChatMessage[]; you: string; onSend?: (text: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const messagesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = messagesRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || !onSend) return;
    setText('');
    await onSend(value);
  };
  return <section className="pointer-events-auto w-[290px] rounded-md border border-white/80 bg-white p-3 shadow-[0_8px_24px_rgba(0,0,0,.28)]" aria-label="Match chat">
    <h2 className="stencil mb-[7px] text-abyss">Match chat</h2>
    <div ref={messagesRef} className="mb-2 max-h-[132px] overflow-y-auto pr-1" aria-live="polite">
      {messages.length === 0 ? <p className="font-mono text-[10px] text-slate-deep/65">No messages yet.</p> : messages.map((message) => <p key={message.id} className="mb-1 font-mono text-[10px] leading-normal text-slate-deep"><span className={message.side === you ? 'font-semibold text-ember' : 'font-semibold text-abyss'}>{message.side === you ? 'You' : message.name}</span><span className="text-slate-deep/40"> · </span>{message.text}</p>)}
    </div>
    <form onSubmit={submit} className="flex gap-2 border-t border-slate-deep/15 pt-2">
      <input value={text} onChange={(event) => setText(event.target.value)} maxLength={240} placeholder="Send a message…" className="min-w-0 flex-1 bg-transparent font-mono text-[10px] text-abyss outline-none placeholder:text-slate-deep/50" />
      <button type="submit" disabled={!text.trim()} className="stencil text-[10px] text-abyss disabled:text-slate-deep/35">Send</button>
    </form>
  </section>;
}
