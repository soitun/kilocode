import {
	AUTOCOMPLETE_PROVIDER_MODELS,
	defaultProviderUsabilityChecker,
	modelIdKeysByProvider,
	ProviderSettingsEntry,
} from "@roo-code/types"
import { ApiHandler, buildApiHandler } from "../../api"
import { ProviderSettingsManager } from "../../core/config/ProviderSettingsManager"
import { OpenRouterHandler } from "../../api/providers"
import { ApiStreamChunk } from "../../api/transform/stream"

export class GhostModel {
	private apiHandler: ApiHandler | null = null
	public loaded = false

	constructor(apiHandler: ApiHandler | null = null) {
		if (apiHandler) {
			this.apiHandler = apiHandler
			this.loaded = true
		}
	}
	private cleanup(): void {
		this.apiHandler = null
		this.loaded = false
	}

	public async reload(providerSettingsManager: ProviderSettingsManager): Promise<boolean> {
		const profiles = await providerSettingsManager.listConfig()
		const supportedProviders = Object.keys(AUTOCOMPLETE_PROVIDER_MODELS) as Array<
			keyof typeof AUTOCOMPLETE_PROVIDER_MODELS
		>

		this.cleanup()

		// Check providers in order, but skip unusable ones (e.g., kilocode with zero balance)
		for (const provider of supportedProviders) {
			const selectedProfile = profiles.find(
				(x): x is typeof x & { apiProvider: string } => x?.apiProvider === provider,
			)
			if (selectedProfile) {
				const isUsable = await defaultProviderUsabilityChecker(provider, providerSettingsManager)
				if (!isUsable) continue

				this.loadProfile(providerSettingsManager, selectedProfile, provider)
				this.loaded = true
				return true
			}
		}

		this.loaded = true // we loaded, and found nothing, but we do not wish to reload
		return false
	}

	public async loadProfile(
		providerSettingsManager: ProviderSettingsManager,
		selectedProfile: ProviderSettingsEntry,
		provider: keyof typeof AUTOCOMPLETE_PROVIDER_MODELS,
	): Promise<void> {
		const profile = await providerSettingsManager.getProfile({
			id: selectedProfile.id,
		})

		this.apiHandler = buildApiHandler({
			...profile,
			[modelIdKeysByProvider[provider]]: AUTOCOMPLETE_PROVIDER_MODELS[provider],
		})

		if (this.apiHandler instanceof OpenRouterHandler) {
			await this.apiHandler.fetchModel()
		}
	}

	/**
	 * Generate response with streaming callback support
	 */
	public async generateResponse(
		systemPrompt: string,
		userPrompt: string,
		onChunk: (chunk: ApiStreamChunk) => void,
	): Promise<{
		cost: number
		inputTokens: number
		outputTokens: number
		cacheWriteTokens: number
		cacheReadTokens: number
	}> {
		if (!this.apiHandler) {
			console.error("API handler is not initialized")
			throw new Error("API handler is not initialized. Please check your configuration.")
		}

		console.log("USED MODEL", this.apiHandler.getModel())

		const stream = this.apiHandler.createMessage(systemPrompt, [
			{ role: "user", content: [{ type: "text", text: userPrompt }] },
		])

		let cost = 0
		let inputTokens = 0
		let outputTokens = 0
		let cacheReadTokens = 0
		let cacheWriteTokens = 0

		try {
			for await (const chunk of stream) {
				// Call the callback with each chunk
				onChunk(chunk)

				// Track usage information
				if (chunk.type === "usage") {
					cost = chunk.totalCost ?? 0
					cacheReadTokens = chunk.cacheReadTokens ?? 0
					cacheWriteTokens = chunk.cacheWriteTokens ?? 0
					inputTokens = chunk.inputTokens ?? 0
					outputTokens = chunk.outputTokens ?? 0
				}
			}
		} catch (error) {
			console.error("Error streaming completion:", error)
			throw error
		}

		return {
			cost,
			inputTokens,
			outputTokens,
			cacheWriteTokens,
			cacheReadTokens,
		}
	}

	public getModelName(): string | null {
		if (!this.apiHandler) return null

		return this.apiHandler.getModel().id ?? "unknown"
	}

	public getProviderDisplayName(): string | null {
		if (!this.apiHandler) return null

		const handler = this.apiHandler as any
		if (handler.providerName && typeof handler.providerName === "string") {
			return handler.providerName
		} else {
			return "unknown"
		}
	}

	public hasValidCredentials(): boolean {
		return this.apiHandler !== null && this.loaded
	}
}
