'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
  Loader2,
  Zap,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

type Provider = 'openai' | 'anthropic' | 'openrouter' | 'ollama';

interface ProviderMeta {
  id: Provider;
  label: string;
  defaultModel: string;
  modelHint: string;
  needsApiKey: boolean;
  baseUrlPlaceholder?: string;
  baseUrlHint?: string;
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    modelHint: 'e.g. gpt-4o-mini, gpt-4.1',
    needsApiKey: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    defaultModel: 'claude-haiku-4-5-20251001',
    modelHint: 'e.g. claude-haiku-4-5-20251001, claude-sonnet-4-6',
    needsApiKey: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (100+ models)',
    defaultModel: 'openai/gpt-4o-mini',
    modelHint: 'e.g. openai/gpt-4o-mini, anthropic/claude-haiku-4.5',
    needsApiKey: true,
  },
  {
    id: 'ollama',
    label: 'Ollama (local, free)',
    defaultModel: 'llama3.2',
    modelHint: 'e.g. llama3.2, qwen2.5, phi3',
    needsApiKey: false,
    baseUrlPlaceholder: 'http://host.docker.internal:11434',
    baseUrlHint: 'Where your Ollama server lives. From inside Docker use host.docker.internal.',
  },
];

const MASKED_KEY = '••••••••••••••••';

type Status = 'connected' | 'disconnected' | 'unknown';

export function AIProviderConfig() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [hasExisting, setHasExisting] = useState(false);
  const [status, setStatus] = useState<Status>('unknown');
  const [statusMessage, setStatusMessage] = useState('');

  const [provider, setProvider] = useState<Provider>('openai');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyEdited, setApiKeyEdited] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [isEnabled, setIsEnabled] = useState(true);

  const meta = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/provider-config');
      const data = await res.json();
      if (data.config) {
        setHasExisting(true);
        setProvider(data.config.provider as Provider);
        setModel(data.config.model || '');
        setBaseUrl(data.config.base_url || '');
        setApiKey(data.config.api_key || '');
        setSystemPrompt(data.config.system_prompt || '');
        setIsEnabled(Boolean(data.config.is_enabled));
        setApiKeyEdited(false);
        setStatus(data.connected ? 'connected' : 'disconnected');
        setStatusMessage(data.message || '');
      } else {
        setHasExisting(false);
        setStatus('disconnected');
        setStatusMessage(data.message || '');
      }
    } catch (err) {
      console.error('Load AI config failed:', err);
      toast.error('Failed to load AI provider configuration');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const onProviderChange = (next: Provider) => {
    setProvider(next);
    const nextMeta = PROVIDERS.find((p) => p.id === next);
    if (nextMeta && !model.trim()) setModel(nextMeta.defaultModel);
  };

  async function handleSave() {
    if (!model.trim()) {
      toast.error('Model is required');
      return;
    }
    if (meta.needsApiKey && !hasExisting && !apiKey.trim()) {
      toast.error('API key is required for initial setup');
      return;
    }

    try {
      setSaving(true);
      const payload: Record<string, unknown> = {
        provider,
        model: model.trim(),
        base_url: baseUrl.trim() || null,
        system_prompt: systemPrompt.trim() || null,
        is_enabled: isEnabled,
      };
      // Send api_key only if the agent actually typed a new one.
      if (apiKeyEdited && apiKey && apiKey !== MASKED_KEY) {
        payload.api_key = apiKey.trim();
      }

      const res = await fetch('/api/ai/provider-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to save');
        return;
      }
      toast.success('AI provider saved');
      await loadConfig();
    } catch (err) {
      console.error('Save AI config failed:', err);
      toast.error('Failed to save AI provider');
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    try {
      setTesting(true);
      const res = await fetch('/api/ai/provider-config');
      const data = await res.json();
      if (data.connected) {
        setStatus('connected');
        toast.success(data.message || 'Connection OK');
      } else {
        setStatus('disconnected');
        toast.error(data.message || 'Connection failed');
      }
      setStatusMessage(data.message || '');
    } catch (err) {
      console.error('Test AI failed:', err);
      toast.error('Test failed');
    } finally {
      setTesting(false);
    }
  }

  async function handleReset() {
    if (!confirm('Delete the saved AI provider config? Suggestions will stop until you reconfigure.')) return;
    try {
      setResetting(true);
      const res = await fetch('/api/ai/provider-config', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Reset failed');
        return;
      }
      toast.success('AI provider cleared');
      setHasExisting(false);
      setApiKey('');
      setApiKeyEdited(false);
      setStatus('disconnected');
      setStatusMessage('');
    } catch (err) {
      console.error('Reset AI failed:', err);
      toast.error('Reset failed');
    } finally {
      setResetting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px] mt-4">
      <div className="space-y-6">
        <Alert className="bg-slate-900 border-slate-700">
          <div className="flex items-center gap-2">
            {status === 'connected' ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <XCircle className="size-4 text-red-500" />
            )}
            <AlertTitle className="text-white mb-0">
              {status === 'connected' ? 'Connected' : 'Not Connected'}
            </AlertTitle>
          </div>
          <AlertDescription className="text-slate-400">
            {status === 'connected'
              ? 'Your AI provider is configured and reachable. Reply suggestions are live in the inbox.'
              : statusMessage || 'Configure a provider below to enable reply suggestions in the inbox.'}
          </AlertDescription>
        </Alert>

        <Card className="bg-slate-900 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              AI Provider
            </CardTitle>
            <CardDescription className="text-slate-400">
              Bring your own LLM key. Keys are encrypted at rest with the same AES-256-GCM scheme as your WhatsApp token.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-slate-300">Provider</Label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onProviderChange(p.id)}
                    className={
                      'rounded-md border px-3 py-2 text-xs transition-colors ' +
                      (provider === p.id
                        ? 'border-primary bg-primary/10 text-white'
                        : 'border-slate-700 bg-slate-800 text-slate-400 hover:text-white')
                    }
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-slate-300">Model</Label>
              <Input
                placeholder={meta.modelHint}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
              />
              <p className="text-xs text-slate-500">{meta.modelHint}</p>
            </div>

            {meta.baseUrlPlaceholder !== undefined && (
              <div className="space-y-2">
                <Label className="text-slate-300">Base URL</Label>
                <Input
                  placeholder={meta.baseUrlPlaceholder}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
                />
                {meta.baseUrlHint && (
                  <p className="text-xs text-slate-500">{meta.baseUrlHint}</p>
                )}
              </div>
            )}

            {meta.needsApiKey && (
              <div className="space-y-2">
                <Label className="text-slate-300">API Key</Label>
                <div className="relative">
                  <Input
                    type={showKey ? 'text' : 'password'}
                    placeholder="Paste your provider API key"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setApiKeyEdited(true);
                    }}
                    onFocus={() => {
                      if (apiKey === MASKED_KEY) {
                        setApiKey('');
                        setApiKeyEdited(true);
                      }
                    }}
                    className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                  >
                    {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                {hasExisting && !apiKeyEdited && (
                  <p className="text-xs text-slate-500">
                    Key hidden for security. Leave as-is to keep current key; type to replace.
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label className="text-slate-300">System Prompt (optional)</Label>
              <textarea
                placeholder="Leave blank for the default WhatsApp-friendly prompt."
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={4}
                className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-primary focus:outline-none"
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={isEnabled}
                onChange={(e) => setIsEnabled(e.target.checked)}
                className="size-4 rounded border-slate-700 bg-slate-800 text-primary focus:ring-primary"
              />
              Enable AI suggestions in the inbox
            </label>
          </CardContent>
        </Card>

        <div className="flex flex-wrap gap-3">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving...
              </>
            ) : (
              'Save Configuration'
            )}
          </Button>
          <Button
            variant="outline"
            onClick={handleTest}
            disabled={testing || !hasExisting}
            className="border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800"
          >
            {testing ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Testing...
              </>
            ) : (
              <>
                <Zap className="size-4" />
                Test Connection
              </>
            )}
          </Button>
          {hasExisting && (
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={resetting}
              className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
            >
              {resetting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Resetting...
                </>
              ) : (
                <>
                  <RotateCcw className="size-4" />
                  Reset
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      <div>
        <Card className="bg-slate-900 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white text-base">How this works</CardTitle>
            <CardDescription className="text-slate-400">
              Your key never reaches the browser.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-400">
            <p>
              When a customer message arrives in the inbox, the server reads the last few messages, calls your chosen LLM, and shows three reply suggestions above the composer.
            </p>
            <p>
              Click a suggestion to drop it in the composer (or send it directly with Shift+Enter). Suggestions are generated on demand, not stored.
            </p>
            <p>
              Spend is billed by your provider, not by wacrm. With Ollama, suggestions are entirely free.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
