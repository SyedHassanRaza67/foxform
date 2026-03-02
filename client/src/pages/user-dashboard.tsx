import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Globe, Search, Save, Trash2, Loader2, UserPlus, Network, Shield,
  FileText, Users, Wifi, ChevronDown, ChevronUp, Eye, CheckCircle2, XCircle
} from "lucide-react";
import type { FormField, Site } from "@shared/schema";

interface Agent {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  assignedSiteIds: string[];
}

interface ProxyConfig {
  proxyHost: string;
  proxyPort: number;
  proxyUsername: string;
  proxyPassword: string;
  proxyType: string;
  proxySiteIds: string[] | null;
}

export function SitesTab() {
  const { toast } = useToast();
  const [url, setUrl] = useState("");
  const [siteName, setSiteName] = useState("");
  const [scrapedFields, setScrapedFields] = useState<FormField[] | null>(null);
  const [formSelector, setFormSelector] = useState<string | null>(null);
  const [submitSelector, setSubmitSelector] = useState<string | null>(null);
  const [expandedSite, setExpandedSite] = useState<string | null>(null);

  const sitesQuery = useQuery<Site[]>({ queryKey: ["/api/sites"] });

  const scrapeMutation = useMutation({
    mutationFn: async (targetUrl: string) => {
      const res = await apiRequest("POST", "/api/sites/scrape", { url: targetUrl });
      return res.json();
    },
    onSuccess: (data) => {
      setScrapedFields(data.fields);
      setFormSelector(data.formSelector);
      setSubmitSelector(data.submitSelector);
      toast({ title: `Found ${data.fields.length} form fields` });
    },
    onError: (err: any) => {
      toast({ title: "Scrape failed", description: err.message, variant: "destructive" });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/sites", {
        name: siteName || new URL(url).hostname,
        url,
        formSelector,
        submitSelector,
        fields: scrapedFields,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sites"] });
      setUrl("");
      setSiteName("");
      setScrapedFields(null);
      toast({ title: "Site saved successfully" });
    },
    onError: (err: any) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/sites/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sites"] });
      toast({ title: "Site deleted" });
    },
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base flex items-center gap-2">
            <Search className="w-4 h-4" />
            Scrape Website Forms
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-3 flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <Input
                placeholder="https://example.com/contact"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                data-testid="input-scrape-url"
              />
            </div>
            <Button
              onClick={() => scrapeMutation.mutate(url)}
              disabled={!url || scrapeMutation.isPending}
              data-testid="button-scrape"
            >
              {scrapeMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Search className="w-4 h-4 mr-2" />
              )}
              Scrape
            </Button>
          </div>

          {scrapedFields && (
            <div className="space-y-4 pt-4">
              <Separator />
              <div className="flex items-center justify-between gap-1 flex-wrap">
                <div>
                  <h3 className="font-semibold text-sm">Detected Fields</h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    {scrapedFields.length} field{scrapedFields.length !== 1 ? "s" : ""} found
                  </p>
                </div>
                <Badge variant="secondary" className="font-mono text-xs">
                  {formSelector || "No form detected"}
                </Badge>
              </div>

              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">#</TableHead>
                      <TableHead>Label</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Selector</TableHead>
                      <TableHead className="text-center">Required</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {scrapedFields.map((f, i) => (
                      <TableRow key={i} data-testid={`row-field-${i}`}>
                        <TableCell className="font-mono text-muted-foreground">{f.order}</TableCell>
                        <TableCell className="font-medium">{f.label || "-"}</TableCell>
                        <TableCell className="font-mono text-sm">{f.name}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-xs">{f.type}</Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground max-w-[200px] truncate">
                          {f.selector}
                        </TableCell>
                        <TableCell className="text-center">
                          {f.required ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-500 mx-auto" />
                          ) : (
                            <XCircle className="w-4 h-4 text-muted-foreground/40 mx-auto" />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="flex gap-3 items-end flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <Label className="text-sm">Site Name</Label>
                  <Input
                    value={siteName}
                    onChange={(e) => setSiteName(e.target.value)}
                    placeholder="My Contact Form"
                    className="mt-1"
                    data-testid="input-site-name"
                  />
                </div>
                <Button
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending || scrapedFields.length === 0}
                  data-testid="button-save-site"
                >
                  {saveMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4 mr-2" />
                  )}
                  Save Site
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div>
        <h3 className="text-lg font-semibold mb-3">Saved Sites</h3>
        {sitesQuery.isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
          </div>
        ) : sitesQuery.data?.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <Globe className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p className="font-medium">No sites yet</p>
              <p className="text-sm mt-1">Paste a URL above and scrape to detect form fields</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {sitesQuery.data?.map((site) => (
              <Card key={site.id} className="hover-elevate" data-testid={`card-site-${site.id}`}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <Globe className="w-5 h-5 text-primary shrink-0" />
                      <div className="min-w-0">
                        <p className="font-medium truncate">{site.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{site.url}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="font-mono">
                        {(site.fields as FormField[])?.length || 0} fields
                      </Badge>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setExpandedSite(expandedSite === site.id ? null : site.id)}
                        data-testid={`button-expand-${site.id}`}
                      >
                        {expandedSite === site.id ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => deleteMutation.mutate(site.id)}
                        data-testid={`button-delete-site-${site.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                  {expandedSite === site.id && (
                    <div className="mt-4 rounded-md border overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-12">#</TableHead>
                            <TableHead>Label</TableHead>
                            <TableHead>Name</TableHead>
                            <TableHead>Type</TableHead>
                            <TableHead className="text-center">Required</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(site.fields as FormField[])?.map((f, i) => (
                            <TableRow key={i}>
                              <TableCell className="font-mono text-muted-foreground">{f.order}</TableCell>
                              <TableCell>{f.label || "-"}</TableCell>
                              <TableCell className="font-mono text-sm">{f.name}</TableCell>
                              <TableCell>
                                <Badge variant="outline" className="font-mono text-xs">{f.type}</Badge>
                              </TableCell>
                              <TableCell className="text-center">
                                {f.required ? (
                                  <CheckCircle2 className="w-4 h-4 text-emerald-500 mx-auto" />
                                ) : (
                                  <XCircle className="w-4 h-4 text-muted-foreground/40 mx-auto" />
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentsTab() {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newAgent, setNewAgent] = useState({ name: "", email: "", password: "", siteIds: [] as string[] });

  const sitesQuery = useQuery<Site[]>({ queryKey: ["/api/sites"] });
  const agentsQuery = useQuery<Agent[]>({ queryKey: ["/api/agents"] });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/agents", newAgent);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      setDialogOpen(false);
      setNewAgent({ name: "", email: "", password: "", siteIds: [] });
      toast({ title: "Agent created" });
    },
    onError: (err: any) => {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/agents/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      toast({ title: "Agent deleted" });
    },
  });

  const toggleSite = (siteId: string) => {
    setNewAgent((prev) => ({
      ...prev,
      siteIds: prev.siteIds.includes(siteId)
        ? prev.siteIds.filter((s) => s !== siteId)
        : [...prev.siteIds, siteId],
    }));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-1 flex-wrap">
        <div>
          <h3 className="text-lg font-semibold">Agent Accounts</h3>
          <p className="text-sm text-muted-foreground mt-1">Create agents and assign them sites to fill forms</p>
        </div>
        <Button onClick={() => setDialogOpen(true)} data-testid="button-create-agent">
          <UserPlus className="w-4 h-4 mr-2" />
          Create Agent
        </Button>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Agent Account</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              createMutation.mutate();
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={newAgent.name}
                onChange={(e) => setNewAgent({ ...newAgent, name: e.target.value })}
                required
                data-testid="input-agent-name"
              />
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input
                type="email"
                value={newAgent.email}
                onChange={(e) => setNewAgent({ ...newAgent, email: e.target.value })}
                required
                data-testid="input-agent-email"
              />
            </div>
            <div className="space-y-2">
              <Label>Password</Label>
              <Input
                type="password"
                value={newAgent.password}
                onChange={(e) => setNewAgent({ ...newAgent, password: e.target.value })}
                required
                minLength={6}
                data-testid="input-agent-password"
              />
            </div>
            <div className="space-y-2">
              <Label>Assign Sites</Label>
              {sitesQuery.data?.length === 0 ? (
                <p className="text-sm text-muted-foreground">No sites available. Create sites first.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {sitesQuery.data?.map((site) => (
                    <Badge
                      key={site.id}
                      variant={newAgent.siteIds.includes(site.id) ? "default" : "outline"}
                      className="cursor-pointer"
                      onClick={() => toggleSite(site.id)}
                      data-testid={`badge-site-${site.id}`}
                    >
                      {site.name}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={createMutation.isPending} data-testid="button-submit-create-agent">
              {createMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Create Agent
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {agentsQuery.isLoading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
        </div>
      ) : agentsQuery.data?.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Users className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="font-medium">No agents yet</p>
            <p className="text-sm mt-1">Create an agent and assign sites for form filling</p>
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Assigned Sites</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agentsQuery.data?.map((agent) => (
                <TableRow key={agent.id} data-testid={`row-agent-${agent.id}`}>
                  <TableCell className="font-medium">{agent.name}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{agent.email}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {agent.assignedSiteIds.map((siteId) => {
                        const site = sitesQuery.data?.find((s) => s.id === siteId);
                        return (
                          <Badge key={siteId} variant="secondary" className="text-xs">
                            {site?.name || siteId.slice(0, 8)}
                          </Badge>
                        );
                      })}
                      {agent.assignedSiteIds.length === 0 && (
                        <span className="text-sm text-muted-foreground">None</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={agent.isActive ? "default" : "destructive"}>
                      {agent.isActive ? "Active" : "Disabled"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => deleteMutation.mutate(agent.id)}
                      data-testid={`button-delete-agent-${agent.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

const PROXY_URL_REGEX = /^(https?|socks5):\/\/([^:@]+):([^@]*)@([^:/]+):(\d+)$/;

function buildProxyUrl(cfg: ProxyConfig): string {
  if (!cfg.proxyHost || !cfg.proxyPort) return "";
  return `${cfg.proxyType || "http"}://${cfg.proxyUsername}:${cfg.proxyPassword}@${cfg.proxyHost}:${cfg.proxyPort}`;
}

function parseProxyUrl(url: string): Partial<ProxyConfig> | null {
  const m = url.trim().match(PROXY_URL_REGEX);
  if (!m) return null;
  return {
    proxyType: m[1],
    proxyUsername: m[2],
    proxyPassword: m[3],
    proxyHost: m[4],
    proxyPort: parseInt(m[5], 10),
  };
}

export function ProxyTab() {
  const { toast } = useToast();

  const proxyQuery = useQuery<ProxyConfig>({ queryKey: ["/api/proxy"] });
  const sitesQuery = useQuery<Site[]>({ queryKey: ["/api/sites"] });

  const [config, setConfig] = useState<ProxyConfig>({
    proxyHost: "",
    proxyPort: 0,
    proxyUsername: "",
    proxyPassword: "",
    proxyType: "http",
    proxySiteIds: null,
  });
  const [urlTemplate, setUrlTemplate] = useState("");
  const [initialized, setInitialized] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; ip?: string; message?: string } | null>(null);

  if (proxyQuery.data && !initialized) {
    const d = proxyQuery.data;
    setConfig(d);
    setUrlTemplate(buildProxyUrl(d));
    setInitialized(true);
  }

  const urlValid = urlTemplate === "" ? null : parseProxyUrl(urlTemplate) !== null;

  const handleUrlChange = (val: string) => {
    setUrlTemplate(val);
    const parsed = parseProxyUrl(val);
    if (parsed) {
      setConfig((prev) => ({ ...prev, ...parsed }));
    }
  };

  const isConfigured = config.proxyHost && config.proxyPort && config.proxyUsername;
  const sites = sitesQuery.data || [];

  const applyToAll = config.proxySiteIds === null;

  const toggleApplyToAll = () => {
    setConfig({ ...config, proxySiteIds: applyToAll ? [] : null });
  };

  const toggleSite = (siteId: string) => {
    const current = config.proxySiteIds ?? [];
    if (current.includes(siteId)) {
      setConfig({ ...config, proxySiteIds: current.filter((id) => id !== siteId) });
    } else {
      setConfig({ ...config, proxySiteIds: [...current, siteId] });
    }
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PUT", "/api/proxy", config);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/proxy"] });
      toast({ title: "Proxy configuration saved" });
    },
    onError: (err: any) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/proxy/test");
      return res.json();
    },
    onSuccess: (data: any) => {
      setTestResult(data);
      if (data.success) {
        toast({ title: "Proxy working!", description: `IP: ${data.ip}` });
      } else {
        toast({ title: "Proxy test failed", description: data.message, variant: "destructive" });
      }
    },
    onError: (err: any) => {
      setTestResult({ success: false, message: err.message });
      toast({ title: "Test failed", description: err.message, variant: "destructive" });
    },
  });

  const hasZipPlaceholder = config.proxyUsername.includes("{zip}");
  const zipPreviewUrl = hasZipPlaceholder
    ? buildProxyUrl({ ...config, proxyUsername: config.proxyUsername.replace(/\{zip\}/g, "90210") })
    : buildProxyUrl(config);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-lg font-semibold">Decodo Proxy Configuration</h3>
          <p className="text-sm text-muted-foreground mt-1">Configure your proxy for geo-targeted form submissions</p>
        </div>
        <Badge variant={isConfigured ? "default" : "secondary"} data-testid="badge-proxy-status">
          {isConfigured ? "Configured" : "Not Configured"}
        </Badge>
      </div>

      <Card>
        <CardContent className="p-6 space-y-5">
          <div className="space-y-2">
            <Label>Proxy URL Template</Label>
            <Input
              placeholder="http://user-{zip}:password@host:port"
              value={urlTemplate}
              onChange={(e) => handleUrlChange(e.target.value)}
              className="font-mono text-sm"
              data-testid="input-proxy-url"
            />
            <div className="flex items-center gap-1.5 min-h-[18px]">
              {urlValid === true && (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  <span className="text-xs text-emerald-500 font-medium">Valid URL</span>
                </>
              )}
              {urlValid === false && (
                <>
                  <XCircle className="w-3.5 h-3.5 text-destructive" />
                  <span className="text-xs text-destructive">Invalid format — expected: <span className="font-mono">http://user:pass@host:port</span></span>
                </>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Use <code className="bg-muted px-1 rounded text-[11px]">{"{zip}"}</code> in the username — it is replaced with the agent's zip code on every submission.
              Example: <span className="font-mono text-[11px]">http://user-country-us-zip-{"{zip}"}:password@us.decodo.com:10003</span>
            </p>
          </div>

          <div className="flex gap-3 flex-wrap">
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !isConfigured}
              data-testid="button-save-proxy"
            >
              {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save Configuration
            </Button>
            <Button
              variant="secondary"
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending || !config.proxyHost}
              data-testid="button-test-proxy"
            >
              {testMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Wifi className="w-4 h-4 mr-2" />}
              Test Connection
            </Button>
          </div>

          {testResult && (
            <div className={`rounded-md p-4 flex items-center gap-3 ${testResult.success ? "bg-emerald-500/10 border border-emerald-500/20" : "bg-destructive/10 border border-destructive/20"}`} data-testid="proxy-test-result">
              {testResult.success ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
              ) : (
                <XCircle className="w-5 h-5 text-destructive shrink-0" />
              )}
              <div>
                <p className="text-sm font-medium">
                  {testResult.success ? "Connection Successful" : "Connection Failed"}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                  {testResult.success ? `External IP: ${testResult.ip}` : testResult.message}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-primary" />
              <h4 className="text-sm font-semibold">Proxy Site Assignment</h4>
            </div>
            <p className="text-xs text-muted-foreground">
              Choose which sites this proxy applies to when agents submit forms.
            </p>
          </div>

          <div className="space-y-3">
            <button
              type="button"
              onClick={toggleApplyToAll}
              className={`w-full flex items-center justify-between rounded-md border px-4 py-3 text-sm transition-colors ${
                applyToAll
                  ? "border-primary bg-primary/5 text-primary"
                  : "border-border bg-muted/30 text-muted-foreground hover:border-primary/50"
              }`}
              data-testid="button-proxy-all-sites"
            >
              <span className="font-medium">All Sites</span>
              <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${applyToAll ? "border-primary bg-primary" : "border-muted-foreground"}`}>
                {applyToAll && <div className="w-2 h-2 rounded-full bg-white" />}
              </div>
            </button>

            {sites.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Or select specific sites</p>
                {sites.map((site) => {
                  const isSelected = !applyToAll && (config.proxySiteIds ?? []).includes(site.id);
                  return (
                    <button
                      key={site.id}
                      type="button"
                      onClick={() => { if (applyToAll) toggleApplyToAll(); toggleSite(site.id); }}
                      className={`w-full flex items-center justify-between rounded-md border px-4 py-2.5 text-sm transition-colors ${
                        isSelected
                          ? "border-primary bg-primary/5"
                          : "border-border bg-background hover:border-primary/50"
                      }`}
                      data-testid={`button-proxy-site-${site.id}`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Globe className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate font-medium">{site.name}</span>
                        <span className="text-[10px] text-muted-foreground truncate hidden sm:block">{site.url}</span>
                      </div>
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${isSelected ? "border-primary bg-primary" : "border-muted-foreground"}`}>
                        {isSelected && <CheckCircle2 className="w-3 h-3 text-white" />}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {sites.length === 0 && !sitesQuery.isLoading && (
              <p className="text-xs text-muted-foreground italic text-center py-3">
                No sites saved yet. Add sites in the Sites tab first.
              </p>
            )}

            <div className="rounded-md bg-muted/50 border border-dashed p-3 text-xs text-muted-foreground">
              {applyToAll ? (
                <span><strong className="text-foreground">All Sites</strong> — proxy will be used for every agent form submission across all your sites.</span>
              ) : (config.proxySiteIds ?? []).length === 0 ? (
                <span className="text-destructive/70">No sites selected — proxy will <strong>not</strong> be applied to any submission until you select sites or switch to All Sites.</span>
              ) : (
                <span><strong className="text-foreground">{(config.proxySiteIds ?? []).length} site{(config.proxySiteIds ?? []).length !== 1 ? "s" : ""} selected</strong> — proxy only applies to these sites.</span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {isConfigured && (
        <Card>
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" />
              <h4 className="text-sm font-semibold">Geo-Targeting Preview</h4>
            </div>
            <p className="text-xs text-muted-foreground">
              {hasZipPlaceholder
                ? "The {zip} placeholder in your proxy URL is automatically replaced with the agent's zip code on every submission."
                : "When agents submit forms, the proxy username is appended with the zip/state from the form for geo-targeted routing."}
            </p>
            <div className="space-y-3">
              <div className="rounded-md bg-muted p-3 space-y-1.5">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">With zip code (e.g. 90210)</p>
                <p className="font-mono text-xs text-primary break-all" data-testid="text-geo-zip-preview">
                  {hasZipPlaceholder
                    ? zipPreviewUrl
                    : `${buildProxyUrl({ ...config, proxyUsername: config.proxyUsername + "-zip-90210" })}`}
                </p>
              </div>
              {!hasZipPlaceholder && (
                <div className="rounded-md bg-muted p-3 space-y-1.5">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">With state (e.g. california)</p>
                  <p className="font-mono text-xs text-primary break-all" data-testid="text-geo-state-preview">
                    {buildProxyUrl({ ...config, proxyUsername: config.proxyUsername + "-state-california" })}
                  </p>
                </div>
              )}
              <div className="rounded-md bg-muted p-3 space-y-1.5">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">No geo data</p>
                <p className="font-mono text-xs break-all" data-testid="text-geo-none-preview">
                  {buildProxyUrl(config)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function UserDashboard() {
  return (
    <div className="space-y-6" data-testid="user-dashboard">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Agents</h1>
        <p className="text-muted-foreground text-sm mt-1">Manage your agents and their site assignments</p>
      </div>
      <AgentsTab />
    </div>
  );
}
