I want to build a dashboard for the probability that US will attack Iran across 2026, based on the Polymarket markets here:
https://polymarket.com/event/us-strikes-iran-by

I want the following features:
* Plot a probability distribution over the rest of 2026, based on all the submarkets
	* Make an informed choice on how to interpolate
* Have toggle that switches between probability distribution and cumulative probability distribution
* Have a time slider - I want to easily view how the probabilities changed over time
	* If it's not too difficult, also have a toggle for "Joy plot" visualization of time, like how TensorBoard can visualize histograms over time (looks similar to a "Joy Division" album cover)
* Automatically update from Polymarket
	* Note that new submarkets are created often, so need to also check for those
* Note that very new submarkets might have low volume, and therefore are not informative. Signify this in some way