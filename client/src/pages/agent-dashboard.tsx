import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
  Globe, Star, Send, Loader2, MapPin, Shield,
  Monitor, CheckCircle2, XCircle, Eye, EyeOff
} from "lucide-react";
import type { FormField, Site } from "@shared/schema";

const ZIP_KEYWORDS = ["zip", "postal"];
const STATE_KEYWORDS = ["state"];
const ZIP_EXACT = ["zip", "zipcode", "zip_code", "postal", "postalcode", "postal_code"];
const STATE_EXACT = ["state", "state_name"];

interface AutoFillProgress {
  step: string;
  detail: string;
  percent: number;
  timestamp: number;
}

export default function AgentDashboard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [expandedSiteId, setExpandedSiteId] = useState<string | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [activeSubmissionId, setActiveSubmissionId] = useState<string | null>(null);
  const [progressUpdates, setProgressUpdates] = useState<AutoFillProgress[]>([]);
  const [currentProgress, setCurrentProgress] = useState<AutoFillProgress | null>(null);
  const [showProgressDialog, setShowProgressDialog] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const progressContainerRef = useRef<HTMLDivElement>(null);

  const sitesQuery = useQuery<Site[]>({ queryKey: ["/api/agent/sites"] });
  const connectSSE = useCallback((submissionId: string) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const token = localStorage.getItem("proxyform_token");
    if (!token) return;
    const es = new EventSource(`/api/agent/submissions/${submissionId}/progress?token=${token}`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const progress: AutoFillProgress = JSON.parse(event.data);
        setCurrentProgress(progress);
        setProgressUpdates((prev) => [...prev, progress]);

        if (progress.step === "complete" || progress.step === "error") {
          es.close();
          eventSourceRef.current = null;
          queryClient.invalidateQueries({ queryKey: ["/api/agent/submissions"] });

          if (progress.step === "complete") {
            toast({ title: "Auto-fill complete", description: progress.detail });
          } else {
            toast({ title: "Auto-fill failed", description: progress.detail, variant: "destructive" });
          }
        }
      } catch {}
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [toast]);

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  useEffect(() => {
    if (progressContainerRef.current) {
      progressContainerRef.current.scrollTop = progressContainerRef.current.scrollHeight;
    }
  }, [progressUpdates]);

  const sites = sitesQuery.data || [];
  const expandedSite = sites.find((s) => s.id === expandedSiteId) || null;

  const submitMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/agent/submissions", {
        siteId: expandedSite?.id,
        formData,
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      setActiveSubmissionId(data.id);
      setProgressUpdates([]);
      setCurrentProgress(null);
      setShowProgressDialog(true);
      connectSSE(data.id);

      const locationMsg = data.proxyLocation ? ` via ${data.proxyLocation}` : "";
      toast({ title: `Submission started${locationMsg}` });
    },
    onError: (err: any) => {
      setShowProgressDialog(false);
      toast({ title: "Submission failed", description: err.message, variant: "destructive" });
    },
  });

  // True from click → until step is complete/error
  const isBusy =
    submitMutation.isPending ||
    (!!activeSubmissionId &&
      currentProgress?.step !== "complete" &&
      currentProgress?.step !== "error");

  const isDone =
    currentProgress?.step === "complete" || currentProgress?.step === "error";

  const isZipField = (name: string) => {
    const k = name.toLowerCase();
    return ZIP_EXACT.includes(k) || ZIP_KEYWORDS.some((kw) => k === kw || k.startsWith(kw + "-") || k.startsWith(kw + "_"));
  };
  const isStateField = (name: string) => {
    const k = name.toLowerCase();
    return STATE_EXACT.includes(k) || STATE_KEYWORDS.some((kw) => k === kw || k.startsWith(kw + "-") || k.startsWith(kw + "_"));
  };
  const isGeoField = (name: string) => isZipField(name) || isStateField(name);

  const expandedFields = expandedSite ? ((expandedSite.fields as FormField[]) || []) : [];

  const geoPreview = useMemo(() => {
    for (const key of Object.keys(formData)) {
      if (isZipField(key) && formData[key]?.trim()) {
        return { type: "zip" as const, value: formData[key].trim(), field: key };
      }
    }
    for (const key of Object.keys(formData)) {
      if (isStateField(key) && formData[key]?.trim()) {
        return { type: "state" as const, value: formData[key].trim().toLowerCase().replace(/\s+/g, "_"), field: key };
      }
    }
    return null;
  }, [formData]);

  const handleToggleSite = (siteId: string) => {
    if (expandedSiteId === siteId) {
      setExpandedSiteId(null);
      setFormData({});
    } else {
      setExpandedSiteId(siteId);
      setFormData({});
    }
  };

  const handleCloseProgress = () => {
    if (!isBusy) {
      setShowProgressDialog(false);
      setActiveSubmissionId(null);
      setProgressUpdates([]);
      setCurrentProgress(null);
    }
  };

  const progressPercent = submitMutation.isPending
    ? 3
    : currentProgress?.percent ?? 0;

  if (sitesQuery.isLoading) {
    return (
      <div className="space-y-4 p-6" data-testid="agent-dashboard">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  if (sites.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]" data-testid="agent-dashboard">
        <Card className="max-w-md w-full">
          <CardContent className="py-12 text-center text-muted-foreground">
            <Globe className="w-12 h-12 mx-auto mb-4 opacity-40" />
            <h3 className="font-semibold text-lg text-foreground mb-2">No Sites Assigned</h3>
            <p className="text-sm">Contact your account manager to get sites assigned to you</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="agent-dashboard">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Agent Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Select a site to fill and submit its form
        </p>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Assigned Sites</h3>
        {sites.map((site) => {
          const siteFields = (site.fields as FormField[]) || [];
          const isExpanded = expandedSiteId === site.id;

          return (
            <Card key={site.id} data-testid={`card-site-${site.id}`}>
              <CardContent className="p-0">
                <button
                  className="w-full p-4 flex items-center justify-between gap-3 text-left hover:bg-muted/50 transition-colors rounded-t-lg"
                  onClick={() => handleToggleSite(site.id)}
                  data-testid={`button-toggle-site-${site.id}`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Globe className="w-5 h-5 text-primary shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium truncate">{site.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{siteFields.length} fields</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline" className="text-xs">
                      {isExpanded ? <EyeOff className="w-3 h-3 mr-1" /> : <Eye className="w-3 h-3 mr-1" />}
                      {isExpanded ? "Close" : "View Form"}
                    </Badge>
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t px-4 pb-4 pt-4 space-y-3 bg-muted/5">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-tight opacity-70 mb-1">{site.url}</p>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3 max-h-[60vh] overflow-y-auto pr-2 custom-scrollbar">
                      {siteFields
                        .sort((a, b) => a.order - b.order)
                        .map((field) => (
                          <div key={field.name} className="space-y-1">
                            <div className="flex items-center gap-2">
                              <Label className="text-[11px] font-medium">
                                {field.label || field.name}
                                {field.required && <span className="text-destructive ml-0.5">*</span>}
                              </Label>
                              {isZipField(field.name) && (
                                <Badge variant="default" className="h-4 text-[9px] px-1 gap-0.5" data-testid={`badge-geo-${field.name}`}>
                                  <Star className="w-2.5 h-2.5" />
                                  PROXY
                                </Badge>
                              )}
                              {isStateField(field.name) && (
                                <Badge variant="secondary" className="h-4 text-[9px] px-1 gap-0.5" data-testid={`badge-geo-${field.name}`}>
                                  <MapPin className="w-2.5 h-2.5" />
                                  GEO
                                </Badge>
                              )}
                            </div>

                            {field.type === "checkbox" ? (
                              <div className="flex items-center gap-2 py-1">
                                <Checkbox
                                  className="h-3.5 w-3.5"
                                  checked={formData[field.name] === (field.options?.[0] || "true")}
                                  onCheckedChange={(checked) =>
                                    setFormData({
                                      ...formData,
                                      [field.name]: checked ? (field.options?.[0] || "true") : "",
                                    })
                                  }
                                  data-testid={`checkbox-field-${field.name}`}
                                />
                                <span className="text-[11px] text-muted-foreground">{field.label || field.name}</span>
                              </div>
                            ) : field.type === "radio" && field.options ? (
                              <div className="flex flex-wrap gap-x-3 gap-y-1 py-1">
                                {field.options.map((opt) => (
                                  <label key={opt} className="flex items-center gap-1.5 cursor-pointer">
                                    <input
                                      type="radio"
                                      name={field.name}
                                      value={opt}
                                      checked={formData[field.name] === opt}
                                      onChange={(e) => setFormData({ ...formData, [field.name]: e.target.value })}
                                      className="h-3 w-3 accent-primary"
                                      data-testid={`radio-field-${field.name}-${opt}`}
                                    />
                                    <span className="text-[11px]">{opt}</span>
                                  </label>
                                ))}
                              </div>
                            ) : field.type === "select" && field.options ? (
                              <Select
                                value={formData[field.name] || ""}
                                onValueChange={(v) => setFormData({ ...formData, [field.name]: v })}
                              >
                                <SelectTrigger className="h-8 text-[11px]" data-testid={`select-field-${field.name}`}>
                                  <SelectValue placeholder={`Select ${field.label || field.name}`} />
                                </SelectTrigger>
                                <SelectContent>
                                  {field.options.map((opt) => (
                                    <SelectItem className="text-[11px]" key={opt} value={opt}>{opt}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : field.type === "textarea" ? (
                              <textarea
                                className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-1.5 text-[11px] ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                placeholder={field.label || field.name}
                                value={formData[field.name] || ""}
                                onChange={(e) => setFormData({ ...formData, [field.name]: e.target.value })}
                                data-testid={`textarea-field-${field.name}`}
                              />
                            ) : (
                              <Input
                                className="h-8 text-[11px]"
                                type={field.type === "email" ? "email" : field.type === "tel" ? "tel" : "text"}
                                placeholder={field.label || field.name}
                                value={formData[field.name] || ""}
                                onChange={(e) => setFormData({ ...formData, [field.name]: e.target.value })}
                                data-testid={`input-field-${field.name}`}
                              />
                            )}
                          </div>
                        ))}
                    </div>

                    {siteFields.some((f) => isGeoField(f.name)) && (
                      <div className="rounded border border-primary/20 bg-primary/5 p-2 space-y-1" data-testid="proxy-preview-card">
                        <div className="flex items-center gap-2">
                          <Shield className="w-3 h-3 text-primary" />
                          <p className="text-[9px] font-bold uppercase tracking-widest text-primary">Geo-Targeting Preview</p>
                        </div>
                        {geoPreview ? (
                          <div className="space-y-0.5">
                            <div className="flex items-center justify-between gap-4">
                              <p className="font-mono text-[11px] text-primary truncate" data-testid="text-proxy-preview">
                                [proxy-user]-{geoPreview.type}-{geoPreview.value}
                              </p>
                              <p className="text-[10px] text-muted-foreground whitespace-nowrap">
                                via <span className="font-mono">{geoPreview.field}</span>
                              </p>
                            </div>
                            <p className="text-[9px] text-emerald-500 font-semibold uppercase tracking-wider">
                              ✓ Geo-targeting active — {geoPreview.type === "zip" ? "zip" : "state"} will route proxy IP
                            </p>
                          </div>
                        ) : (
                          <p className="text-[10px] text-muted-foreground italic">
                            Enter a zip or state to activate geo-targeting
                          </p>
                        )}
                      </div>
                    )}

                    <Button
                      className="w-full h-9 text-xs font-semibold"
                      onClick={() => submitMutation.mutate()}
                      disabled={submitMutation.isPending || isBusy}
                      data-testid="button-submit-form"
                    >
                      {submitMutation.isPending ? (
                        <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                      ) : (
                        <Send className="w-3.5 h-3.5 mr-2" />
                      )}
                      Submit & Auto-Fill
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Auto-fill progress dialog */}
      <Dialog open={showProgressDialog} onOpenChange={handleCloseProgress}>
        <DialogContent className="max-w-lg" data-testid="dialog-autofill-progress">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Monitor className="w-5 h-5" />
              Auto-Fill Progress
              {isBusy && <Loader2 className="w-4 h-4 animate-spin text-primary" />}
              {currentProgress?.step === "complete" && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
              {currentProgress?.step === "error" && <XCircle className="w-4 h-4 text-destructive" />}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span data-testid="text-progress-detail">
                  {submitMutation.isPending
                    ? "Creating submission..."
                    : currentProgress?.detail || "Starting browser..."}
                </span>
                <span className="font-mono font-semibold tabular-nums" data-testid="text-progress-percent">
                  {progressPercent}%
                </span>
              </div>
              <Progress value={progressPercent} className="h-2.5" data-testid="progress-autofill" />
            </div>

            {progressUpdates.length > 0 && (
              <div
                ref={progressContainerRef}
                className="max-h-56 overflow-y-auto rounded-md bg-muted p-3 space-y-1 text-[11px] font-mono"
              >
                {progressUpdates.map((p, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="text-muted-foreground shrink-0 w-10 tabular-nums">
                      {Math.round((p.timestamp - progressUpdates[0].timestamp) / 1000)}s
                    </span>
                    <span className={
                      p.step === "error" || p.step === "field_warning" || p.step === "submit_warning"
                        ? "text-destructive"
                        : p.step === "complete"
                        ? "text-emerald-500"
                        : "text-foreground"
                    }>
                      {p.detail}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {isBusy && progressUpdates.length === 0 && (
              <div className="flex items-center justify-center gap-3 py-4 text-muted-foreground text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Launching browser & navigating to page...</span>
              </div>
            )}

            {isDone && (
              <Button
                className="w-full"
                variant={currentProgress?.step === "complete" ? "default" : "destructive"}
                onClick={handleCloseProgress}
                data-testid="button-close-progress"
              >
                {currentProgress?.step === "complete" ? (
                  <><CheckCircle2 className="w-4 h-4 mr-2" />Done</>
                ) : (
                  <><XCircle className="w-4 h-4 mr-2" />Close</>
                )}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}
