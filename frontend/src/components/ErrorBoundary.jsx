import { Component } from 'react';

/**
 * ErrorBoundary — Catches React render crashes gracefully.
 * Props:
 *   - fallbackLabel: optional string to show in the error card title
 *   - children: the subtree to protect
 */
export class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }
    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }
    componentDidCatch(error, info) {
        console.error(`[OmegaWallet] ${this.props.fallbackLabel || 'Renderer'} crash:`, error, info.componentStack);
    }
    render() {
        if (this.state.hasError) {
            return (
                <div className="onboarding-container fade-in">
                    <div className="onboarding-card" style={{ textAlign: 'center' }}>
                        <div className="omega-icon" style={{ width: 64, height: 64, fontSize: '2rem', margin: '0 auto 24px', background: 'rgba(255,23,68,0.15)', color: '#ff1744' }}>!</div>
                        <h2 style={{ marginBottom: 8, color: '#ff1744' }}>
                            {this.props.fallbackLabel ? `${this.props.fallbackLabel} Error` : 'Something Went Wrong'}
                        </h2>
                        <p style={{ color: 'var(--text-secondary)', marginBottom: 8, fontSize: '0.85rem' }}>
                            The wallet UI encountered an error. Your keys remain in the main process.</p>
                        <p style={{ color: 'var(--text-muted)', marginBottom: 24, fontSize: '0.75rem', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
                            {this.state.error?.message || 'Unknown error'}</p>
                        <button className="btn btn-primary btn-lg" style={{ width: '100%' }}
                            onClick={() => this.setState({ hasError: false, error: null })}>
                            Try Again
                        </button>
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}
