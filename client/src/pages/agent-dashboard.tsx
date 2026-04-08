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
  Globe, Star, Send, Loader2, MapPin, Shield, History,
  Monitor, CheckCircle2, XCircle, Eye, EyeOff, CheckCircle, RefreshCcw
} from "lucide-react";
import type { FormField, Site } from "@shared/schema";
import { SiteForm } from "@/components/site-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const ZIP_KEYWORDS = ["zip", "postal"];
const STATE_KEYWORDS = ["state"];
const COUNTY_KEYWORDS = ["county"];
const ZIP_EXACT = ["zip", "zipcode", "zip_code", "postal", "postalcode", "postal_code"];
const STATE_EXACT = ["state", "state_name"];
const COUNTY_EXACT = ["county", "county_name"];

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
  const [activeProxyMethod, setActiveProxyMethod] = useState<string | null>(null);
  const [activeProxyLocation, setActiveProxyLocation] = useState<string | null>(null);
  const [progressUpdates, setProgressUpdates] = useState<AutoFillProgress[]>([]);
  const [currentProgress, setCurrentProgress] = useState<AutoFillProgress | null>(null);
  const [showProgressDialog, setShowProgressDialog] = useState(false);
  const [lastSuccessSiteId, setLastSuccessSiteId] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const progressContainerRef = useRef<HTMLDivElement>(null);

  const sitesQuery = useQuery<Site[]>({ queryKey: ["/api/agent/sites"] });
  const submissionsQuery = useQuery<any[]>({ queryKey: ["/api/agent/submissions"] });
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
            setLastSuccessSiteId(submissionId); // We use submissionId to identify the last success for the specific site
            setExpandedSiteId(null); // Close the dropdown on success as requested
            toast({ title: "Auto-fill complete", description: progress.detail });
          } else {
            toast({ title: "Auto-fill failed", description: progress.detail, variant: "destructive" });
          }
        }
      } catch { }
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
    onMutate: () => {
      // Instant UI feedback as requested
      setShowProgressDialog(true);
      setProgressUpdates([{
        step: "starting",
        detail: "Initializing submission...",
        percent: 1,
        timestamp: Date.now()
      }]);
    },
    onSuccess: (data: any) => {
      setActiveSubmissionId(data.id);
      setActiveProxyMethod(data.proxyMethod);
      setActiveProxyLocation(data.proxyLocation);
      // We don't reset updates here anymore as they might have already started
      setCurrentProgress(null);
      connectSSE(data.id);

      const locationMsg = data.proxyLocation ? ` via ${data.proxyLocation}` : "";
      toast({ title: `Submission started${locationMsg}` });
    },
    onError: (err: any) => {
      // If there's an immediate error (e.g. 400), show it in the progress list
      setProgressUpdates((prev) => [...prev, {
        step: "error",
        detail: `Submission failed: ${err.message}`,
        percent: 100,
        timestamp: Date.now()
      }]);
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

  const expandedFields = expandedSite ? ((expandedSite.fields as FormField[]) || []) : [];

  const isZipField = (name: string) => {
    const field = expandedFields.find(f => f.name === name);
    if (field?.geoRole === "zip") return true;
    const k = name.toLowerCase();
    if (ZIP_EXACT.includes(k)) return true;
    if (ZIP_KEYWORDS.some((kw) => k === kw || k.startsWith(kw + "-") || k.startsWith(kw + "_"))) return true;
    return ZIP_KEYWORDS.some((kw) => k.includes("_" + kw) || k.includes("-" + kw));
  };
  const isStateField = (name: string) => {
    const field = expandedFields.find(f => f.name === name);
    if (field?.geoRole === "state") return true;
    const k = name.toLowerCase();
    if (STATE_EXACT.includes(k)) return true;
    if (STATE_KEYWORDS.some((kw) => k === kw || k.startsWith(kw + "-") || k.startsWith(kw + "_"))) return true;
    return STATE_KEYWORDS.some((kw) => k.includes("_" + kw) || k.includes("-" + kw));
  };
  const isCountyField = (name: string) => {
    const field = expandedFields.find(f => f.name === name);
    if (field?.geoRole === "county") return true;
    const k = name.toLowerCase();
    if (COUNTY_EXACT.includes(k)) return true;
    if (COUNTY_KEYWORDS.some((kw) => k === kw || k.startsWith(kw + "-") || k.startsWith(kw + "_"))) return true;
    return COUNTY_KEYWORDS.some((kw) => k.includes("_" + kw) || k.includes("-" + kw));
  };
  const isGeoField = (name: string) => isZipField(name) || isStateField(name) || isCountyField(name);

  const geoPreview = useMemo(() => {
    let zip = null;
    let state = null;
    let county = null;
    for (const key of Object.keys(formData)) {
      if (isZipField(key) && formData[key]?.trim()) {
        zip = { type: "zip" as const, value: formData[key].trim(), field: key };
        break;
      }
    }
    for (const key of Object.keys(formData)) {
      if (isStateField(key) && formData[key]?.trim()) {
        state = { type: "state" as const, value: formData[key].trim(), field: key };
        break;
      }
    }
    for (const key of Object.keys(formData)) {
      if (isCountyField(key) && formData[key]?.trim()) {
        county = { type: "county" as const, value: formData[key].trim().toLowerCase().replace(/\s+/g, "_"), field: key };
        break;
      }
    }
    return { zip, state, county };
  }, [formData, expandedFields]);

  const lastSuccessfulSub = useMemo(() => {
    if (!expandedSiteId) return null;
    const subs = submissionsQuery.data || [];
    return subs
      .filter(s => s.siteId === expandedSiteId && s.status === "success")
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  }, [expandedSiteId, submissionsQuery.data]);

  const handleAutofillLast = () => {
    if (lastSuccessfulSub?.formData) {
      setFormData(lastSuccessfulSub.formData as Record<string, string>);
      toast({ title: "Form Autofilled", description: "Loaded data from your last successful submission." });
    }
  };

  const handleToggleSite = (siteId: string) => {
    if (expandedSiteId === siteId) {
      setExpandedSiteId(null);
      setFormData({});
      setLastSuccessSiteId(null);
    } else {
      setExpandedSiteId(siteId);
      setFormData({});
      setLastSuccessSiteId(null);
    }
  };

  const handleCloseForm = () => {
    if (!isBusy) {
      setExpandedSiteId(null);
      setFormData({});
      setLastSuccessSiteId(null);
    }
  };

  const handleCloseProgress = () => {
    // If submission is active, cancel it on the server
    if (isBusy && activeSubmissionId) {
      console.log(`[dashboard] Logic: Closing busy progress window, sending cancel request for ${activeSubmissionId}`);
      apiRequest("POST", `/api/agent/submissions/${activeSubmissionId}/cancel`).catch(() => { });
      toast({ title: "Submission Cancelled", description: "The automation has been stopped." });
    }

    // User requested to fix close icon - allow closure even if busy
    setShowProgressDialog(false);

    // Only reset the background state if it's finished, otherwise keep it for background tracking
    if (!isBusy) {
      setActiveSubmissionId(null);
      setActiveProxyMethod(null);
      setActiveProxyLocation(null);
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
        <h1 className="text-2xl font-bold tracking-tight text-primary">Welcome, {user?.name}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Select a site to fill and submit its form
        </p>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Assigned Sites</h3>
        {sites.map((site) => {
          const siteFields = (site.fields as FormField[]) || [];
          return (
            <Card key={site.id} data-testid={`card-site-${site.id}`} className="group hover:border-primary/30 transition-all duration-300">
              <CardContent className="p-0">
                <button
                  className="w-full p-4 flex items-center justify-between gap-3 text-left hover:bg-muted/30 transition-colors rounded-lg"
                  onClick={() => handleToggleSite(site.id)}
                  data-testid={`button-toggle-site-${site.id}`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-full bg-primary/5 flex items-center justify-center shrink-0">
                      <Globe className="w-5 h-5 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold truncate">{site.name}</p>
                      <p className="text-xs text-muted-foreground truncate opacity-70">{siteFields.length} fields • {site.url}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline" className="text-xs group-hover:bg-primary/5 transition-colors">
                      <Eye className="w-3 h-3 mr-1" />
                      View Form
                    </Badge>
                  </div>
                </button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Site Form Modal with Backdrop Blur */}
      <Dialog open={!!expandedSiteId} onOpenChange={handleCloseForm}>
        <DialogContent className="max-w-2xl backdrop-blur-md bg-background/95" data-testid="dialog-site-form">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <Globe className="w-5 h-5 text-primary" />
              <DialogTitle className="flex flex-col">
                <span>{expandedSite?.name}</span>
                <span className="text-[10px] text-muted-foreground font-normal uppercase tracking-tight opacity-70">
                  {expandedSite?.url}
                </span>
              </DialogTitle>
            </div>
          </DialogHeader>

          <div className="space-y-4 pt-4">
            <div className="flex items-center justify-between gap-4">
              {lastSuccessfulSub && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[10px] gap-1.5 border-emerald-500/30 text-emerald-600 hover:bg-emerald-50"
                  onClick={handleAutofillLast}
                  disabled={isBusy}
                >
                  <RefreshCcw className="w-3 h-3" />
                  Fill with Last Successful Data
                </Button>
              )}
              {lastSuccessSiteId && (
                <Alert className="bg-emerald-500/10 border-emerald-500/20 text-emerald-600 py-2 flex-1">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-3 w-3 text-emerald-500" />
                    <AlertTitle className="text-[10px] font-bold uppercase tracking-wider mb-0">Success</AlertTitle>
                  </div>
                </Alert>
              )}
            </div>

            <div className="max-h-[60vh] overflow-y-auto pr-2 custom-scrollbar">
              {expandedSite && (
                <SiteForm
                  site={expandedSite}
                  formData={formData}
                  setFormData={setFormData}
                  isReadOnly={isBusy}
                />
              )}
            </div>

            <Button
              className="w-full h-10 font-bold tracking-tight shadow-lg shadow-primary/20"
              onClick={() => submitMutation.mutate()}
              disabled={submitMutation.isPending || isBusy}
              data-testid="button-submit-form"
            >
              {submitMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Send className="w-4 h-4 mr-2" />
              )}
              Submit & Auto-Fill
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Auto-fill progress dialog */}
      <Dialog open={showProgressDialog} onOpenChange={handleCloseProgress}>
        <DialogContent className="max-w-lg" data-testid="dialog-autofill-progress">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between gap-2 overflow-hidden">
              <div className="flex items-center gap-2 truncate">
                <Monitor className="w-5 h-5 shrink-0" />
                <span className="truncate">Auto-Fill Progress</span>
                {isBusy && <Loader2 className="w-4 h-4 animate-spin text-primary shrink-0" />}
                {currentProgress?.step === "complete" && <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />}
                {currentProgress?.step === "error" && <XCircle className="w-4 h-4 text-destructive shrink-0" />}
              </div>

              {activeProxyMethod && activeProxyMethod !== 'none' && (
                <Badge
                  variant="outline"
                  className={`ml-auto text-[10px] shrink-0 gap-1 px-1.5 py-0 ${activeProxyMethod === 'zip'
                    ? 'text-emerald-500 border-emerald-500/30 bg-emerald-500/5'
                    : activeProxyMethod === 'state'
                      ? 'text-amber-500 border-amber-500/30 bg-amber-500/5'
                      : activeProxyMethod === 'county'
                        ? 'text-blue-500 border-blue-500/30 bg-blue-500/5'
                        : 'text-purple-500 border-purple-500/30 bg-purple-500/5'
                    }`}
                >
                  {activeProxyMethod === 'zip'
                    ? `Zip()`
                    : activeProxyMethod === 'state'
                      ? `State()`
                      : activeProxyMethod === 'county'
                        ? `County()`
                        : `Country()`}
                </Badge>
              )}
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
                      p.step === "error"
                        ? "text-destructive"
                        : p.step === "field_warning" || p.step === "submit_warning"
                          ? "text-amber-400"
                          : p.step === "complete"
                            ? "text-emerald-500"
                            : "text-foreground"
                    }>
                      {p.step === "field_warning" ? "⚠ " : ""}{p.detail}
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

    </div >
  );
}
