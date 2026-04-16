import * as React from "react"
import { PanelLeft } from "lucide-react"

import { cn } from "../../lib/utils"
import { Button } from "./button"

const SIDEBAR_WIDTH = "240px"
const SIDEBAR_WIDTH_COLLAPSED = "0px"

interface SidebarContext {
  open: boolean
  setOpen: (open: boolean) => void
  toggleSidebar: () => void
}

const SidebarContext = React.createContext<SidebarContext | null>(null)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.")
  }
  return context
}

interface SidebarProviderProps extends React.ComponentProps<"div"> {
  defaultOpen?: boolean
}

const SidebarProvider = React.forwardRef<HTMLDivElement, SidebarProviderProps>(
  ({ defaultOpen = true, className, children, ...props }, ref) => {
    const [open, setOpen] = React.useState(defaultOpen)

    const toggleSidebar = React.useCallback(() => {
      setOpen((prev) => !prev)
    }, [])

    const contextValue = React.useMemo<SidebarContext>(
      () => ({ open, setOpen, toggleSidebar }),
      [open, toggleSidebar]
    )

    return (
      <SidebarContext.Provider value={contextValue}>
        <div ref={ref} className={cn("flex min-h-0", className)} {...props}>
          {children}
        </div>
      </SidebarContext.Provider>
    )
  }
)
SidebarProvider.displayName = "SidebarProvider"

interface SidebarProps extends React.ComponentProps<"aside"> {
  panelWidth?: number;
}

const Sidebar = React.forwardRef<HTMLDivElement, SidebarProps>(
  ({ className, children, panelWidth, style, ...props }, ref) => {
    const { open } = useSidebar()
    const width = open
      ? panelWidth != null ? `${panelWidth}px` : SIDEBAR_WIDTH
      : SIDEBAR_WIDTH_COLLAPSED

    return (
      <aside
        ref={ref}
        data-state={open ? "expanded" : "collapsed"}
        className={cn(
          "flex h-full flex-col overflow-hidden border-r border-border bg-sidebar-bg",
          className
        )}
        style={{ width, ...style }}
        {...props}
      >
        {children}
      </aside>
    )
  }
)
Sidebar.displayName = "Sidebar"

const SidebarHeader = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={cn("flex items-center gap-2 px-4 py-3", className)}
      {...props}
    />
  )
})
SidebarHeader.displayName = "SidebarHeader"

const SidebarContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden",
        className
      )}
      {...props}
    />
  )
})
SidebarContent.displayName = "SidebarContent"

interface SidebarTriggerProps extends React.ComponentProps<typeof Button> { }

const SidebarTrigger = React.forwardRef<HTMLButtonElement, SidebarTriggerProps>(
  ({ className, onClick, ...props }, ref) => {
    const { toggleSidebar } = useSidebar()

    return (
      <Button
        ref={ref}
        variant="ghost"
        size="icon"
        className={cn("h-8 w-8 focus-visible:ring-2 focus-visible:ring-primary-border focus-visible:outline-none", className)}
        onClick={(event) => {
          onClick?.(event)
          toggleSidebar()
        }}
        {...props}
      >
        <PanelLeft className="h-4 w-4" />
        <span className="sr-only">Toggle Sidebar</span>
      </Button>
    )
  }
)
SidebarTrigger.displayName = "SidebarTrigger"

export {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
}
