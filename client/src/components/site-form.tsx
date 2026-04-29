import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Star, MapPin, Shield, Info } from "lucide-react";
import type { FormField, Site } from "@shared/schema";

interface SiteFormProps {
    site: Site;
    formData: Record<string, string>;
    setFormData: (data: Record<string, string>) => void;
    isReadOnly?: boolean;
}

const ZIP_KEYWORDS = ["zip", "postal"];
const STATE_KEYWORDS = ["state"];
const ZIP_EXACT = ["zip", "zipcode", "zip_code", "postal", "postalcode", "postal_code"];
const STATE_EXACT = ["state", "state_name"];
const COUNTY_KEYWORDS = ["county"];
const COUNTY_EXACT = ["county", "county_name"];

const US_STATES = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"
];

export function SiteForm({ site, formData, setFormData, isReadOnly = false }: SiteFormProps) {
    const siteFields = ((site.fields as FormField[]) || []).filter(f => !f.hidden);

    const isZipField = (f: FormField) => {
        if (f.geoRole === "zip") return true;
        const k = f.name.toLowerCase();
        return ZIP_EXACT.includes(k) || ZIP_KEYWORDS.some((kw) => k === kw || k.startsWith(kw + "-") || k.startsWith(kw + "_"));
    };
    const isStateField = (f: FormField) => {
        if (f.geoRole === "state") return true;
        const k = f.name.toLowerCase();
        return STATE_EXACT.includes(k) || STATE_KEYWORDS.some((kw) => k === kw || k.startsWith(kw + "-") || k.startsWith(kw + "_"));
    };
    const isCountyField = (f: FormField) => {
        if (f.geoRole === "county") return true;
        const k = f.name.toLowerCase();
        return COUNTY_EXACT.includes(k) || COUNTY_KEYWORDS.some((kw) => k === kw || k.startsWith(kw + "-") || k.startsWith(kw + "_"));
    };
    const isGeoField = (f: FormField) => isZipField(f) || isStateField(f) || isCountyField(f);

    const geoPreview = (() => {
        let zip = null;
        let state = null;
        let county = null;
        for (const f of siteFields) {
            const val = formData[f.name];
            if (isZipField(f) && val?.trim()) {
                zip = { type: "zip" as const, value: val.trim(), field: f.name };
            }
            if (isStateField(f) && val?.trim()) {
                state = { type: "state" as const, value: val.trim().toLowerCase().replace(/\s+/g, "_"), field: f.name };
            }
            if (isCountyField(f) && val?.trim()) {
                county = { type: "county" as const, value: val.trim().toLowerCase().replace(/\s+/g, "_"), field: f.name };
            }
        }
        return { zip, state, county };
    })();

    return (
        <div className="space-y-4">
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
                                {isZipField(field) && (
                                    <Badge variant="default" className="h-4 text-[9px] px-1 gap-0.5" data-testid={`badge-geo-${field.name}`}>
                                        <Star className="w-2.5 h-2.5" />
                                        PROXY
                                    </Badge>
                                )}
                                {isStateField(field) && (
                                    <Badge variant="secondary" className="h-4 text-[9px] px-1 gap-0.5" data-testid={`badge-geo-${field.name}`}>
                                        <MapPin className="w-2.5 h-2.5" />
                                        GEO
                                    </Badge>
                                )}
                                {isCountyField(field) && (
                                    <Badge variant="outline" className="h-4 text-[9px] px-1 gap-0.5 border-blue-500/30 text-blue-500 bg-blue-500/5" data-testid={`badge-geo-${field.name}`}>
                                        <Info className="w-2.5 h-2.5" />
                                        COUNTY
                                    </Badge>
                                )}
                            </div>

                            {field.type === "checkbox" ? (
                                <div className="flex items-center gap-2 py-1">
                                    <Checkbox
                                        className="h-3.5 w-3.5"
                                        disabled={isReadOnly}
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
                                                disabled={isReadOnly}
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
                            ) : (field.type === "select" && field.options) || isStateField(field) ? (
                                <Select
                                    disabled={isReadOnly}
                                    value={formData[field.name] || ""}
                                    onValueChange={(v) => setFormData({ ...formData, [field.name]: v })}
                                >
                                    <SelectTrigger className="h-8 text-[11px]" data-testid={`select-field-${field.name}`}>
                                        <SelectValue placeholder={`Select ${field.label || field.name}`} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {(isStateField(field) ? US_STATES : (field.options || [])).map((opt) => (
                                            <SelectItem className="text-[11px]" key={opt} value={opt}>{opt}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            ) : field.type === "textarea" ? (
                                <textarea
                                    readOnly={isReadOnly}
                                    autoComplete="off"
                                    className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-1.5 text-[11px] ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                                    placeholder={field.label || field.name}
                                    value={formData[field.name] || ""}
                                    onChange={(e) => setFormData({ ...formData, [field.name]: e.target.value })}
                                    data-testid={`textarea-field-${field.name}`}
                                />
                            ) : (
                                <Input
                                    className={`h-8 text-[11px] ${isZipField(field) ? "border-emerald-500/30 focus-visible:ring-emerald-500/50" :
                                        isCountyField(field) ? "border-blue-500/30 focus-visible:ring-blue-500/50" : ""
                                        }`}
                                    autoComplete="off"
                                    readOnly={isReadOnly}
                                    type={field.type === "email" ? "email" : field.type === "tel" ? "tel" : "text"}
                                    placeholder={field.label || field.name}
                                    value={formData[field.name] || ""}
                                    onChange={(e) => {
                                        let val = e.target.value;
                                        const isPhone = field.type === "tel" || field.name.toLowerCase().includes("phone") || field.label?.toLowerCase().includes("phone");

                                        if (isZipField(field)) {
                                            val = val.replace(/\D/g, "").slice(0, 5);
                                        } else if (isPhone) {
                                            // Handle phone: strip non-digits, limit to 10, then format as XXX XXX XXXX
                                            const digits = val.replace(/\D/g, "").slice(0, 10);
                                            let formatted = "";
                                            if (digits.length > 0) {
                                                formatted += digits.substring(0, 3);
                                                if (digits.length > 3) {
                                                    formatted += " " + digits.substring(3, 6);
                                                }
                                                if (digits.length > 6) {
                                                    formatted += " " + digits.substring(6, 10);
                                                }
                                            }
                                            val = formatted;
                                        }
                                        setFormData({ ...formData, [field.name]: val });
                                    }}
                                    maxLength={isZipField(field) ? 5 : (field.type === "tel" || field.name.toLowerCase().includes("phone") || field.label?.toLowerCase().includes("phone")) ? 12 : undefined}
                                    data-testid={`input-field-${field.name}`}
                                />
                            )}
                        </div>
                    ))}
            </div>

            {siteFields.some((f) => isGeoField(f)) && (
                <div className="space-y-2" data-testid="proxy-preview-section">
                    <div className="flex items-center gap-2">
                        <Shield className="w-3 h-3 text-primary" />
                        <p className="text-[9px] font-bold uppercase tracking-widest text-primary">Proxy Routing Priority</p>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                        {/* Priority 1 Card */}
                        <div className={`rounded border p-1.5 space-y-1 transition-all ${geoPreview.zip ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-dashed opacity-50 bg-muted/20'}`}>
                            <div className="flex items-center justify-between">
                                <p className={`text-[7px] font-bold uppercase tracking-tighter ${geoPreview.zip ? 'text-emerald-500' : 'text-muted-foreground'}`}>Prio 1</p>
                                {geoPreview.zip && <Badge variant="outline" className="h-3 text-[7px] text-emerald-500 border-emerald-500/20 px-1 py-0">ZIP</Badge>}
                            </div>
                            {geoPreview.zip ? (
                                <div className="space-y-0.5">
                                    <p className="font-mono text-[8px] text-emerald-600 truncate">[..]-zip-{geoPreview.zip.value}</p>
                                    <p className="text-[7px] text-emerald-500/70 font-medium">Automatic Testing (15s)</p>
                                </div>
                            ) : (
                                <p className="text-[7px] text-muted-foreground italic">No ZIP</p>
                            )}
                        </div>

                        {/* Priority 2 Card */}
                        <div className={`rounded border p-1.5 space-y-1 transition-all ${geoPreview.state ? 'border-amber-500/30 bg-amber-500/5' : 'border-dashed opacity-50 bg-muted/20'}`}>
                            <div className="flex items-center justify-between">
                                <p className={`text-[7px] font-bold uppercase tracking-tighter ${geoPreview.state ? 'text-amber-500' : 'text-muted-foreground'}`}>Prio 2</p>
                                {geoPreview.state && <Badge variant="outline" className="h-3 text-[7px] text-amber-500 border-amber-500/20 px-1 py-0">STATE</Badge>}
                            </div>
                            {geoPreview.state ? (
                                <div className="space-y-0.5">
                                    <p className="font-mono text-[8px] text-amber-600 truncate">[..]-state-{geoPreview.state.value}</p>
                                    <p className="text-[7px] text-amber-500/70 font-medium">Fallback Route</p>
                                </div>
                            ) : (
                                <p className="text-[7px] text-muted-foreground italic">No State</p>
                            )}
                        </div>

                        {/* Priority 3 Card */}
                        <div className={`rounded border p-1.5 space-y-1 transition-all ${geoPreview.county ? 'border-blue-500/30 bg-blue-500/5' : 'border-dashed opacity-50 bg-muted/20'}`}>
                            <div className="flex items-center justify-between">
                                <p className={`text-[7px] font-bold uppercase tracking-tighter ${geoPreview.county ? 'text-blue-500' : 'text-muted-foreground'}`}>Prio 3</p>
                                {geoPreview.county && <Badge variant="outline" className="h-3 text-[7px] text-blue-500 border-blue-500/20 px-1 py-0">COUNTY</Badge>}
                            </div>
                            {geoPreview.county ? (
                                <div className="space-y-0.5">
                                    <p className="font-mono text-[8px] text-blue-600 truncate">[..]-county-{geoPreview.county.value}</p>
                                    <p className="text-[7px] text-blue-500/70 font-medium">Fallback Route</p>
                                </div>
                            ) : (
                                <p className="text-[7px] text-muted-foreground italic">No County</p>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
