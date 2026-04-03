import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Globe, Search, Save, Trash2, Loader2, UserPlus, Network, Shield,
  FileText, Users, Wifi, ChevronDown, ChevronUp, Eye, CheckCircle2, XCircle, Monitor, Activity
} from "lucide-react";
import type { FormField, Site } from "@shared/schema";
import { SiteForm } from "@/components/site-form";

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
  proxyStateUsername: string;
  proxyCountyUsername: string;
  proxyCountryUsername: string;
  proxySiteIds: string[] | null;
}

function extractLinks(text?: string | null): string[] {
  if (!text) return [];
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.match(urlRegex) || [];
}

export function SitesTab() {
  const { toast } = useToast();
  const [url, setUrl] = useState("");
  const [siteName, setSiteName] = useState("");
  const [scrapedFields, setScrapedFields] = useState<FormField[] | null>(null);
  const [formSelector, setFormSelector] = useState<string | null>(null);
  const [submitSelector, setSubmitSelector] = useState<string | null>(null);
  const [googleSheetUrl, setGoogleSheetUrl] = useState("");
  const [expandedSite, setExpandedSite] = useState<string | null>(null);
  const [previewSite, setPreviewSite] = useState<Site | null>(null);
  const [previewData, setPreviewData] = useState<Record<string, string>>({});
  // geoRoleEdits: siteId -> { fieldName -> geoRole }
  const [geoRoleEdits, setGeoRoleEdits] = useState<Record<string, Record<string, "zip" | "state" | "county" | null>>>({});
  // noteEdits: siteId -> note text
  const [noteEdits, setNoteEdits] = useState<Record<string, string>>({});

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
        googleSheetUrl: googleSheetUrl || null,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sites"] });
      setUrl("");
      setSiteName("");
      setGoogleSheetUrl("");
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

  const updateFieldRolesMutation = useMutation({
    mutationFn: async ({ siteId, fields, notes }: { siteId: string; fields?: FormField[]; notes?: string }) => {
      await apiRequest("PUT", `/api/sites/${siteId}`, { fields, notes });
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sites"] });
      // Clear local edits so the UI reflects the saved DB state
      if (variables.fields) {
        setGeoRoleEdits((prev) => {
          const next = { ...prev };
          delete next[variables.siteId];
          return next;
        });
      }
      if (variables.notes !== undefined) {
        setNoteEdits((prev) => {
          const next = { ...prev };
          delete next[variables.siteId];
          return next;
        });
      }
      toast({ title: "Site updated successfully" });
    },
    onError: (err: any) => {
      toast({ title: "Save failed", description: String(err?.message || err), variant: "destructive" });
    },
  });

  const handleGeoRoleChange = (site: Site, fieldName: string, role: "zip" | "state" | "county" | null) => {
    const siteId = site.id;
    setGeoRoleEdits((prev) => {
      const current = { ...(prev[siteId] || {}) };

      if (role === "zip" || role === "state" || role === "county") {
        // Clear any OTHER field that currently holds this same role (from local edits)
        for (const k of Object.keys(current)) {
          if (current[k] === role && k !== fieldName) delete current[k];
        }
        // Also clear from DB-level roles by explicitly overriding conflicting fields
        for (const f of (site.fields as FormField[])) {
          if (f.geoRole === role && f.name !== fieldName && !(f.name in current)) {
            current[f.name] = null;
          }
        }
      }

      current[fieldName] = role;
      return { ...prev, [siteId]: current };
    });
  };

  const handleSaveGeoRoles = (site: Site) => {
    const edits = geoRoleEdits[site.id] || {};
    const updatedFields = (site.fields as FormField[]).map((f) => ({
      ...f,
      geoRole: f.name in edits ? edits[f.name] : (f.geoRole ?? null),
    }));
    updateFieldRolesMutation.mutate({ siteId: site.id, fields: updatedFields });
  };

  const handleSaveNotes = (site: Site) => {
    const notes = noteEdits[site.id];
    if (notes === undefined) return;
    updateFieldRolesMutation.mutate({ siteId: site.id, notes } as any);
  };

  const getFieldGeoRole = (site: Site, fieldName: string): "zip" | "state" | "county" | null => {
    if (site.id in geoRoleEdits && fieldName in geoRoleEdits[site.id]) {
      return geoRoleEdits[site.id][fieldName];
    }
    const field = (site.fields as FormField[]).find((f) => f.name === fieldName);
    return field?.geoRole ?? null;
  };

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
                <div className="flex-1 min-w-[200px]">
                  <Label className="text-sm">Google Sheet Link (Optional)</Label>
                  <Input
                    value={googleSheetUrl}
                    onChange={(e) => setGoogleSheetUrl(e.target.value)}
                    placeholder="https://docs.google.com/spreadsheets/d/..."
                    className="mt-1"
                    data-testid="input-google-sheet-url"
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
                        {site.googleSheetUrl && (
                          <a
                            href={site.googleSheetUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-primary hover:underline flex items-center gap-1 mt-0.5"
                          >
                            <FileText className="w-2.5 h-2.5" />
                            Google Sheet
                          </a>
                        )}
                      </div>
                    </div>
                    {site.notes && (
                      <div className="w-full mt-2 flex flex-wrap gap-2 px-8">
                        {extractLinks(site.notes).map((link, idx) => (
                          <a
                            key={idx}
                            href={link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="bg-primary/10 text-primary px-2 py-0.5 rounded text-[10px] flex items-center gap-1 hover:bg-primary/20 transition-colors"
                          >
                            <Globe className="w-2.5 h-2.5" />
                            {new URL(link).hostname}
                          </a>
                        ))}
                      </div>
                    )}
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
                        onClick={() => {
                          setPreviewSite(site);
                          setPreviewData({});
                        }}
                        title="View Form"
                        data-testid={`button-view-form-${site.id}`}
                      >
                        <Eye className="w-4 h-4 text-primary" />
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
                    <div className="mt-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-semibold">Field Geo Roles</p>
                          <p className="text-xs text-muted-foreground mt-0.5">Assign which field is ZIP (prio 1), State (prio 2), or County (prio 3).</p>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => handleSaveGeoRoles(site)}
                          disabled={updateFieldRolesMutation.isPending}
                        >
                          {updateFieldRolesMutation.isPending ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : <Save className="w-3 h-3 mr-1.5" />}
                          Save Roles
                        </Button>
                      </div>

                      <Separator className="my-4" />

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-semibold">Saved Links & Important Details</p>
                            <p className="text-xs text-muted-foreground mt-0.5">Keep track of affiliate links, login details, or specific notes for this site.</p>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleSaveNotes(site)}
                            disabled={updateFieldRolesMutation.isPending || noteEdits[site.id] === undefined}
                            data-testid={`button-save-notes-${site.id}`}
                          >
                            {updateFieldRolesMutation.isPending ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : <Save className="w-3 h-3 mr-1.5" />}
                            Save Info
                          </Button>
                        </div>
                        <Textarea
                          placeholder="Paste links or type your notes here... (e.g. https://github.com/ ...)"
                          className="min-h-[100px] text-sm resize-none focus-visible:ring-primary/40"
                          value={noteEdits[site.id] !== undefined ? noteEdits[site.id] : (site.notes || "")}
                          onChange={(e) => setNoteEdits({ ...noteEdits, [site.id]: e.target.value })}
                          data-testid={`textarea-notes-${site.id}`}
                        />
                      </div>

                      <Separator className="my-4" />
                      <div className="rounded-md border overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="w-10">#</TableHead>
                              <TableHead>Label</TableHead>
                              <TableHead>Name</TableHead>
                              <TableHead>Type</TableHead>
                              <TableHead className="text-center w-36">Geo Role</TableHead>
                              <TableHead className="text-center">Required</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {(site.fields as FormField[])?.map((f, i) => {
                              const role = getFieldGeoRole(site, f.name);
                              return (
                                <TableRow key={i}>
                                  <TableCell className="font-mono text-muted-foreground">{f.order}</TableCell>
                                  <TableCell>{f.label || "-"}</TableCell>
                                  <TableCell className="font-mono text-sm">{f.name}</TableCell>
                                  <TableCell>
                                    <Badge variant="outline" className="font-mono text-xs">{f.type}</Badge>
                                  </TableCell>
                                  <TableCell className="text-center">
                                    <Select
                                      value={role ?? "none"}
                                      onValueChange={(v) => handleGeoRoleChange(site, f.name, v === "none" ? null : v as "zip" | "state" | "county")}
                                    >
                                      <SelectTrigger className={`h-7 text-xs w-28 mx-auto ${role === "zip" ? "border-emerald-500/60 text-emerald-500 bg-emerald-500/5" :
                                        role === "state" ? "border-amber-500/60 text-amber-500 bg-amber-500/5" :
                                          role === "county" ? "border-blue-500/60 text-blue-500 bg-blue-500/5" : ""
                                        }`}>
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="none">— None —</SelectItem>
                                        <SelectItem value="zip">📍 ZIP</SelectItem>
                                        <SelectItem value="state">🗺 State</SelectItem>
                                        <SelectItem value="county">🏢 County</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </TableCell>
                                  <TableCell className="text-center">
                                    {f.required ? (
                                      <CheckCircle2 className="w-4 h-4 text-emerald-500 mx-auto" />
                                    ) : (
                                      <XCircle className="w-4 h-4 text-muted-foreground/40 mx-auto" />
                                    )}
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={!!previewSite} onOpenChange={(open) => !open && setPreviewSite(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Monitor className="w-5 h-5 text-primary" />
              Form Preview: {previewSite?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="py-4">
            {previewSite && (
              <div className="rounded-lg border p-6 bg-muted/5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-tight opacity-70 mb-4">{previewSite.url}</p>
                <SiteForm
                  site={previewSite}
                  formData={previewData}
                  setFormData={setPreviewData}
                  isReadOnly={false}
                />
              </div>
            )}
          </div>
          <div className="flex justify-end pt-2">
            <Button variant="secondary" onClick={() => setPreviewSite(null)}>Close Preview</Button>
          </div>
        </DialogContent>
      </Dialog>
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
    proxyStateUsername: "",
    proxyCountyUsername: "",
    proxyCountryUsername: "",
    proxySiteIds: null,
  });
  const [urlTemplate, setUrlTemplate] = useState("");
  const [stateUrlTemplate, setStateUrlTemplate] = useState("");
  const [countyUrlTemplate, setCountyUrlTemplate] = useState("");
  const [countryUrlTemplate, setCountryUrlTemplate] = useState("");
  const [initialized, setInitialized] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; ip?: string; message?: string } | null>(null);

  if (proxyQuery.data && !initialized) {
    const d = proxyQuery.data;
    setConfig(d);
    setUrlTemplate(buildProxyUrl(d));
    setStateUrlTemplate(
      d.proxyStateUsername
        ? `${d.proxyType || "http"}://${d.proxyStateUsername}:${d.proxyPassword}@${d.proxyHost}:${d.proxyPort}`
        : ""
    );
    setCountyUrlTemplate(
      d.proxyCountyUsername
        ? `${d.proxyType || "http"}://${d.proxyCountyUsername}:${d.proxyPassword}@${d.proxyHost}:${d.proxyPort}`
        : ""
    );
    setCountryUrlTemplate(
      d.proxyCountryUsername
        ? `${d.proxyType || "http"}://${d.proxyCountryUsername}:${d.proxyPassword}@${d.proxyHost}:${d.proxyPort}`
        : ""
    );
    setInitialized(true);
  }

  const urlValid = urlTemplate === "" ? null : parseProxyUrl(urlTemplate) !== null;
  const stateUrlValid = stateUrlTemplate === "" ? null : parseProxyUrl(stateUrlTemplate) !== null;
  const countyUrlValid = countyUrlTemplate === "" ? null : parseProxyUrl(countyUrlTemplate) !== null;
  const countryUrlValid = countryUrlTemplate === "" ? null : parseProxyUrl(countryUrlTemplate) !== null;

  const handleUrlChange = (val: string) => {
    setUrlTemplate(val);
    const parsed = parseProxyUrl(val);
    if (parsed) {
      setConfig((prev) => ({ ...prev, ...parsed }));
    }
  };

  const handleStateUrlChange = (val: string) => {
    setStateUrlTemplate(val);
    const parsed = parseProxyUrl(val);
    if (parsed) {
      setConfig((prev) => ({ ...prev, proxyStateUsername: parsed.proxyUsername || "" }));
    } else if (val === "") {
      setConfig((prev) => ({ ...prev, proxyStateUsername: "" }));
    }
  };

  const handleCountyUrlChange = (val: string) => {
    setCountyUrlTemplate(val);
    const parsed = parseProxyUrl(val);
    if (parsed) {
      setConfig((prev) => ({ ...prev, proxyCountyUsername: parsed.proxyUsername || "" }));
    } else if (val === "") {
      setConfig((prev) => ({ ...prev, proxyCountyUsername: "" }));
    }
  };

  const handleCountryUrlChange = (val: string) => {
    setCountryUrlTemplate(val);
    const parsed = parseProxyUrl(val);
    if (parsed) {
      setConfig((prev) => ({ ...prev, proxyCountryUsername: parsed.proxyUsername || "" }));
    } else if (val === "") {
      setConfig((prev) => ({ ...prev, proxyCountryUsername: "" }));
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

  const hasZipPlaceholder = (config.proxyUsername ?? "").includes("{zip}");
  const hasStatePlaceholder = (config.proxyStateUsername ?? "").includes("{state}");
  const hasCountyPlaceholder = (config.proxyCountyUsername ?? "").includes("{county}");
  const hasCountryPlaceholder = (config.proxyCountryUsername ?? "").includes("{country}");

  const zipPreviewUrl = hasZipPlaceholder
    ? buildProxyUrl({ ...config, proxyUsername: config.proxyUsername.replace(/\{zip\}/g, "90210") })
    : buildProxyUrl(config);

  const statePreviewUrl = config.proxyStateUsername
    ? buildProxyUrl({
      ...config,
      proxyUsername: hasStatePlaceholder
        ? config.proxyStateUsername.replace(/\{state\}/g, "ca")
        : `${config.proxyStateUsername}-ca`
    })
    : "";

  const countyPreviewUrl = config.proxyCountyUsername
    ? buildProxyUrl({
      ...config,
      proxyUsername: hasCountyPlaceholder
        ? config.proxyCountyUsername.replace(/\{county\}/g, "orange_county")
        : `${config.proxyCountyUsername}-orange_county`
    })
    : "";

  const countryPreviewUrl = config.proxyCountryUsername
    ? buildProxyUrl({
      ...config,
      proxyUsername: hasCountryPlaceholder
        ? config.proxyCountryUsername.replace(/\{country\}/g, "us")
        : `${config.proxyCountryUsername}-us`
    })
    : "";


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
          {/* Priority 1: ZIP Proxy */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">1</div>
              <Label className="text-sm font-semibold">ZIP Proxy URL (Priority 1)</Label>
            </div>
            <Input
              placeholder="http://user-zip-{zip}:password@us.decodo.com:10003"
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
              Use <code className="bg-muted px-1 rounded text-[11px]">{"{zip}"}</code> in the username — replaced with the agent's ZIP code on every submission.<br />
              Example: <span className="font-mono text-[11px]">http://user-zip-{"{zip}"}:password@us.decodo.com:10003</span>
            </p>
          </div>

          {/* Priority 2: State Proxy */}
          <div className="space-y-2 pt-1 border-t">
            <div className="flex items-center gap-2 pt-1">
              <div className="w-5 h-5 rounded-full bg-amber-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">2</div>
              <Label className="text-sm font-semibold">State Proxy URL (Priority 2 — Fallback)</Label>
            </div>
            <Input
              placeholder="http://user-state-{state}:password@us.decodo.com:10003"
              value={stateUrlTemplate}
              onChange={(e) => handleStateUrlChange(e.target.value)}
              className="font-mono text-sm border-amber-500/30 focus-visible:ring-amber-500/50"
              data-testid="input-proxy-state-url"
            />
            <div className="flex items-center gap-1.5 min-h-[18px]">
              {stateUrlValid === true && (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-amber-500" />
                  <span className="text-xs text-amber-500 font-medium">Valid URL</span>
                </>
              )}
              {stateUrlValid === false && (
                <>
                  <XCircle className="w-3.5 h-3.5 text-destructive" />
                  <span className="text-xs text-destructive">Invalid format — expected: <span className="font-mono">http://user:pass@host:port</span></span>
                </>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Use <code className="bg-muted px-1 rounded text-[11px]">{"{state}"}</code> in the username — replaced with the agent's state code (e.g. <span className="font-mono">ca</span>) on every submission.<br />
              Example: <span className="font-mono text-[11px]">http://user-state-{"{state}"}:password@us.decodo.com:10003</span>
            </p>
          </div>

          {/* Priority 3: County Proxy */}
          <div className="space-y-2 pt-1 border-t">
            <div className="flex items-center gap-2 pt-1">
              <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">3</div>
              <Label className="text-sm font-semibold">County Proxy URL (Priority 3 — Fallback)</Label>
            </div>
            <Input
              placeholder="http://user-county-{county}:password@us.decodo.com:10003"
              value={countyUrlTemplate}
              onChange={(e) => handleCountyUrlChange(e.target.value)}
              className="font-mono text-sm border-blue-500/30 focus-visible:ring-blue-500/50"
              data-testid="input-proxy-county-url"
            />
            <div className="flex items-center gap-1.5 min-h-[18px]">
              {countyUrlValid === true && (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-blue-500" />
                  <span className="text-xs text-blue-500 font-medium">Valid URL</span>
                </>
              )}
              {countyUrlValid === false && (
                <>
                  <XCircle className="w-3.5 h-3.5 text-destructive" />
                  <span className="text-xs text-destructive">Invalid format — expected: <span className="font-mono">http://user:pass@host:port</span></span>
                </>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Use <code className="bg-muted px-1 rounded text-[11px]">{"{county}"}</code> in the username — replaced with the agent's county name on every submission.<br />
              Example: <span className="font-mono text-[11px]">http://user-county-{"{county}"}:password@us.decodo.com:10003</span>
            </p>
          </div>

          {/* Priority 4: Country Proxy */}
          <div className="space-y-2 pt-1 border-t">
            <div className="flex items-center gap-2 pt-1">
              <div className="w-5 h-5 rounded-full bg-purple-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">4</div>
              <Label className="text-sm font-semibold">Country Proxy URL (Priority 4 — Final Fallback)</Label>
            </div>
            <Input
              placeholder="http://user-country-{country}:password@us.decodo.com:10003"
              value={countryUrlTemplate}
              onChange={(e) => handleCountryUrlChange(e.target.value)}
              className="font-mono text-sm border-purple-500/30 focus-visible:ring-purple-500/50"
              data-testid="input-proxy-country-url"
            />
            <div className="flex items-center gap-1.5 min-h-[18px]">
              {countryUrlValid === true && (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-purple-500" />
                  <span className="text-xs text-purple-500 font-medium">Valid URL</span>
                </>
              )}
              {countryUrlValid === false && (
                <>
                  <XCircle className="w-3.5 h-3.5 text-destructive" />
                  <span className="text-xs text-destructive">Invalid format — expected: <span className="font-mono">http://user:pass@host:port</span></span>
                </>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Use <code className="bg-muted px-1 rounded text-[11px]">{"{country}"}</code> in the username — replaced with the country code (e.g. <span className="font-mono">us</span>) on every submission.<br />
              Example: <span className="font-mono text-[11px]">http://user-country-{"{country}"}:password@us.decodo.com:10003</span>
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
              className={`w-full flex items-center justify-between rounded-md border px-4 py-3 text-sm transition-colors ${applyToAll
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
                      className={`w-full flex items-center justify-between rounded-md border px-4 py-2.5 text-sm transition-colors ${isSelected
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
              <h4 className="text-sm font-semibold">Geo-Targeting Live Preview</h4>
            </div>
            <p className="text-xs text-muted-foreground">
              This is how the proxy URLs will look when agents submit forms with ZIP and State data.
            </p>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
              {/* Priority 1 — ZIP */}
              <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <div className="w-4 h-4 rounded-full bg-emerald-500 flex items-center justify-center text-white text-[8px] font-bold">1</div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-500">ZIP (e.g. 90210)</p>
                </div>
                <p className="font-mono text-[10px] text-emerald-600 break-all" data-testid="text-geo-zip-preview">
                  {zipPreviewUrl || <span className="text-muted-foreground italic">No ZIP Proxy</span>}
                </p>
              </div>
              {/* Priority 2 — State */}
              <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3 space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <div className="w-4 h-4 rounded-full bg-amber-500 flex items-center justify-center text-white text-[8px] font-bold">2</div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-amber-500">State (e.g. CA)</p>
                </div>
                <p className="font-mono text-[10px] text-amber-600 break-all" data-testid="text-geo-state-preview">
                  {statePreviewUrl || <span className="text-muted-foreground italic">No State Proxy</span>}
                </p>
              </div>
              {/* Priority 3 — County */}
              <div className="rounded-md border border-blue-500/20 bg-blue-500/5 p-3 space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <div className="w-4 h-4 rounded-full bg-blue-500 flex items-center justify-center text-white text-[8px] font-bold">3</div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-blue-500">County (e.g. Orange)</p>
                </div>
                <p className="font-mono text-[10px] text-blue-600 break-all" data-testid="text-geo-county-preview">
                  {countyPreviewUrl || <span className="text-muted-foreground italic">No County Proxy</span>}
                </p>
              </div>
              {/* Priority 4 — Country */}
              <div className="rounded-md border border-purple-500/20 bg-purple-500/5 p-3 space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <div className="w-4 h-4 rounded-full bg-purple-500 flex items-center justify-center text-white text-[8px] font-bold">4</div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-purple-500">Country (e.g. US)</p>
                </div>
                <p className="font-mono text-[10px] text-purple-600 break-all" data-testid="text-geo-country-preview">
                  {countryPreviewUrl || <span className="text-muted-foreground italic">No Country Proxy</span>}
                </p>
              </div>
            </div>
            {!config.proxyStateUsername && !config.proxyCountyUsername && !config.proxyCountryUsername && (
              <p className="text-[11px] text-amber-600/80 bg-amber-500/5 border border-amber-500/20 rounded px-3 py-2">
                ⚠️ No fallback proxies configured — if ZIP proxy fails, the submission will <strong>fail immediately</strong>.
              </p>
            )}
          </CardContent>
        </Card>
      )}

    </div>
  );
}

export function SubmissionsTab() {
  const { user, isLoading: authLoading } = useAuth();

  const isAgent = user?.role === "agent";
  const isUser = user?.role === "user";
  const isAdmin = user?.role === "admin";

  const submissionsEndpoint = isAgent ? "/api/agent/submissions" : "/api/submissions";
  const sitesEndpoint = isAgent ? "/api/agent/sites" : "/api/sites";

  const submissionsQuery = useQuery<any[]>({
    queryKey: [submissionsEndpoint],
    queryFn: async () => {
      const res = await apiRequest("GET", submissionsEndpoint);
      return res.json();
    },
    enabled: !!user && !authLoading && (isAgent || isUser)
  });

  const sitesQuery = useQuery<Site[]>({
    queryKey: [sitesEndpoint],
    queryFn: async () => {
      const res = await apiRequest("GET", sitesEndpoint);
      return res.json();
    },
    enabled: !!user && !authLoading && (isAgent || isUser)
  });

  const data = submissionsQuery.data || [];
  const total = data.length;
  const successes = data.filter(s => s.status === "success").length;
  const failures = data.filter(s => s.status === "failed").length;
  const successRate = total > 0 ? Math.round((successes / total) * 100) : 0;

  // Group by day
  const dailyStats = data.reduce((acc: Record<string, any>, sub) => {
    const day = new Date(sub.createdAt).toLocaleDateString();
    if (!acc[day]) acc[day] = { day, total: 0, success: 0, failed: 0 };
    acc[day].total++;
    if (sub.status === "success") acc[day].success++;
    else if (sub.status === "failed") acc[day].failed++;
    return acc;
  }, {});

  const sortedDays = Object.values(dailyStats).sort((a: any, b: any) =>
    new Date(b.day).getTime() - new Date(a.day).getTime()
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Total Submissions</p>
                <p className="text-2xl font-bold mt-1">{total}</p>
              </div>
              <Activity className="w-8 h-8 text-primary opacity-20" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Success Rate</p>
                <p className="text-2xl font-bold mt-1 text-emerald-500">{successRate}%</p>
              </div>
              <CheckCircle2 className="w-8 h-8 text-emerald-500 opacity-20" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Failed</p>
                <p className="text-2xl font-bold mt-1 text-destructive">{failures}</p>
              </div>
              <XCircle className="w-8 h-8 text-destructive opacity-20" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead className="text-center">Total Submissions</TableHead>
                <TableHead className="text-center">Success</TableHead>
                <TableHead className="text-center">Failed</TableHead>
                <TableHead className="text-right">Success Rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {submissionsQuery.isLoading || sitesQuery.isLoading ? (
                <TableRow><TableCell colSpan={5} className="text-center py-8"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></TableCell></TableRow>
              ) : (submissionsQuery.isError || sitesQuery.isError) ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-destructive">
                    <p className="font-medium">Failed to load data</p>
                  </TableCell>
                </TableRow>
              ) : sortedDays.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No submissions recorded</TableCell></TableRow>
              ) : (
                sortedDays.map((day: any) => (
                  <TableRow key={day.day}>
                    <TableCell className="font-medium">{day.day}</TableCell>
                    <TableCell className="text-center font-mono">{day.total}</TableCell>
                    <TableCell className="text-center text-emerald-500 font-mono">{day.success}</TableCell>
                    <TableCell className="text-center text-destructive font-mono">{day.failed}</TableCell>
                    <TableCell className="text-right font-mono font-bold">
                      {Math.round((day.success / day.total) * 100)}%
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

export function SubmissionsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Form Submissions</h1>
        <p className="text-muted-foreground text-sm mt-1">View results and data captured from automated form fillings</p>
      </div>
      <SubmissionsTab />
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
