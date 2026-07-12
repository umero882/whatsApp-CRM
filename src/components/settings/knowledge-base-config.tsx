'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BookOpen, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface KbDocument {
  id: string;
  title: string;
  content: string;
  embedding_status: 'embedded' | 'text_only' | 'error';
  chunk_count: number;
  updated_at: string;
}

const STATUS_BADGE: Record<KbDocument['embedding_status'], { label: string; className: string }> = {
  embedded: { label: 'Semantic + text search', className: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30' },
  text_only: { label: 'Text search only', className: 'bg-amber-500/15 text-amber-500 border-amber-500/30' },
  error: { label: 'Embedding failed', className: 'bg-red-500/15 text-red-500 border-red-500/30' },
};

/**
 * Settings → Knowledge. The operator curates the documents the AI
 * agent retrieves via search_knowledge_base: visa process, fee
 * inclusions, refund policy, timelines, etc. Ingestion (chunking +
 * embedding) happens server-side in the /api/ai/kb routes.
 */
export function KnowledgeBaseConfig() {
  const [loading, setLoading] = useState(true);
  const [documents, setDocuments] = useState<KbDocument[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<KbDocument | null>(null);
  const [deleting, setDeleting] = useState<KbDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const fetchDocuments = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/ai/kb');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed to load documents');
      setDocuments(body.documents ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load knowledge base');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  function openCreate() {
    setEditing(null);
    setTitle('');
    setContent('');
    setDialogOpen(true);
  }

  function openEdit(doc: KbDocument) {
    setEditing(doc);
    setTitle(doc.title);
    setContent(doc.content);
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!title.trim() || !content.trim()) {
      toast.error('Title and content are both required');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(editing ? `/api/ai/kb/${editing.id}` : '/api/ai/kb', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), content: content.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Save failed');
      toast.success(
        body.embeddingStatus === 'embedded'
          ? `Saved — ${body.chunkCount} chunk${body.chunkCount === 1 ? '' : 's'} embedded`
          : `Saved ${body.chunkCount} chunk${body.chunkCount === 1 ? '' : 's'} (text search only)`,
      );
      setDialogOpen(false);
      await fetchDocuments();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/kb/${deleting.id}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Delete failed');
      toast.success('Document deleted');
      setDeleting(null);
      await fetchDocuments();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5" /> Knowledge Base
          </CardTitle>
          <CardDescription>
            Teach the AI agent your business facts — visa process, what fees include, refund and
            replacement policy, timelines. The agent looks answers up here (search_knowledge_base)
            instead of guessing.
          </CardDescription>
        </div>
        <Button onClick={openCreate} size="sm">
          <Plus className="mr-1 h-4 w-4" /> Add document
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : documents.length === 0 ? (
          <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
            No documents yet. Add your first one — e.g. &quot;What our placement fee includes&quot; or
            &quot;Visa process step by step&quot;.
          </div>
        ) : (
          <div className="space-y-3">
            {documents.map((doc) => {
              const badge = STATUS_BADGE[doc.embedding_status];
              return (
                <div
                  key={doc.id}
                  className="flex items-start justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{doc.title}</p>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{doc.content}</p>
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline" className={badge.className}>{badge.label}</Badge>
                      <span>{doc.chunk_count} chunk{doc.chunk_count === 1 ? '' : 's'}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="icon" onClick={() => openEdit(doc)} aria-label="Edit">
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setDeleting(doc)} aria-label="Delete">
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={(o) => !busy && setDialogOpen(o)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit document' : 'Add document'}</DialogTitle>
            <DialogDescription>
              Plain text works best. Saving re-chunks and re-embeds the document.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="kb-title">Title</Label>
              <Input
                id="kb-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder='e.g. "What the placement fee includes"'
                maxLength={200}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="kb-content">Content</Label>
              <Textarea
                id="kb-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="The facts the agent should answer from…"
                rows={12}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {editing ? 'Save changes' : 'Add document'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleting} onOpenChange={(o) => !busy && !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{deleting?.title}”?</DialogTitle>
            <DialogDescription>
              The agent will no longer be able to answer from this document. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
