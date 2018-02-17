import * as express from 'express'
import * as bodyParser from 'body-parser'

declare function ws(this: express.Server, url: string, callback: any)
declare function ws(this: express.Express, url: string, callback: any)

declare module "express" {
    interface Server {
        ws(url: string, callback: any)
    }

    interface Express {
        ws(url: string, callback: any)
    }
}

interface Offer {
    id: string
    offererMessage: string
    offererSocket: WebSocket

    answererMessage: string
    answererSocket: WebSocket
}

interface Message {
    type: string
    data: any
}

class OffersIndex {
    private offers: Offer[] = []

    registerNewOffer(offer) {
        this.offers.push(offer)
        // TODO register a timeout
    }

    get count() {
        return this.offers.length
    }

    findById(offerId) {
        return this.offers.find(o => o.id == offerId)
    }

    removeById(offerId): Offer {
        let offer = this.findById(offerId)
        if (!offer)
            return null

        this.offers = this.offers.filter(o => offerId != o.id)
        return offer
    }

    forEachSocketOffers(ws: WebSocket, cb: (offer: Offer) => any) {
        this.offers.forEach(offer => {
            if (ws == offer.offererSocket || ws == offer.answererSocket)
                cb(offer)
        })
    }

    removeSocketOffers(ws: WebSocket) {
        this.offers = this.offers.filter(o => ws !== o.answererSocket && ws !== o.offererSocket)
    }
}

function createExpressApp(port: number) {
    let app = express() as express.Express

    let offers = new OffersIndex()
    let wss = new Set<WebSocket>()

    require('express-ws')(app)
    app.use(bodyParser.json())

    app.listen(port, '0.0.0.0', () => console.log(`listening http on port ${port}`))

    app.use(function (req, res, next) {
        res.header("Access-Control-Allow-Origin", "*")
        res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept")
        next()
    })

    app.ws('/signal', (ws, req) => {
        wss.add(ws)

        console.log(`new ws ${wss.size}`)

        ws.on('message', raw => {
            let message = JSON.parse(raw) as Message

            switch (message.type) {
                case 'offer': {
                    let { offerId, offerMessage } = message.data

                    let offer: Offer = {
                        id: offerId,
                        offererMessage: offerMessage,
                        offererSocket: ws,
                        answererMessage: null,
                        answererSocket: null
                    }

                    offers.registerNewOffer(offer)
                    console.log(`offered channel, ${offers.count} left`)

                    let signalingPayload = JSON.stringify({ type: 'offer', data: { offerId: offer.id, offerMessage: offer.offererMessage } })
                    wss.forEach((info, peer) => peer != ws && send(peer, signalingPayload))
                } break

                case 'answer': {
                    let { offerId, answerMessage, sdp } = message.data

                    let offer = offers.findById(offerId)
                    if (!offer || offer.answererSocket) {
                        send(ws, JSON.stringify({ type: 'confirmation', data: { offerId, status: false } }))
                        break
                    }

                    // TODO give the offerer the possibility to decline the offer

                    offer.answererSocket = ws
                    offer.answererMessage = answerMessage

                    send(offer.offererSocket, JSON.stringify({ type: 'answer', data: { offerId, answerMessage } }))
                    send(offer.answererSocket, JSON.stringify({
                        type: 'confirmation', data: {
                            offerId,
                            status: true,
                            offerMessage: offer.offererMessage
                        }
                    }))
                } break

                case 'dataMessage': {
                    let { offerId, payload } = message.data

                    let offer = offers.findById(offerId)
                    if (!offer)
                        break

                    try {
                        if (ws === offer.offererSocket)
                            send(offer.answererSocket, JSON.stringify({ type: 'dataMessage', data: { offerId, payload } }))
                        else if (ws === offer.answererSocket)
                            send(offer.offererSocket, JSON.stringify({ type: 'dataMessage', data: { offerId, payload } }))
                        else
                            console.log(`lost data message on offer ${offerId}: ${payload}`)
                    }
                    catch (error) {
                        console.log(`error proxying a dataMessage ${error}`)
                    }
                } break

                case 'close': {
                    let { offerId } = message.data

                    let offer = offers.removeById(offerId)
                    if (!offer)
                        break

                    console.log(`closed channel, ${offers.count} left`)

                    try {
                        if (ws === offer.offererSocket)
                            send(offer.answererSocket, JSON.stringify({ type: 'close', data: { offerId } }))
                        else if (ws === offer.answererSocket)
                            send(offer.offererSocket, JSON.stringify({ type: 'close', data: { offerId } }))
                        else
                            console.log(`lost close message on offer ${offerId}`)
                    }
                    catch (error) {
                        console.log(`error proxying a close event ${error}`)
                    }
                } break
            }
        })

        ws.on('error', err => {
            console.log(`error on ws ${err}, closing`)

            ws.close()
        })

        ws.on('close', () => {
            offers.forEachSocketOffers(ws, offer => {
                if (ws == offer.offererSocket)
                    send(offer.answererSocket, JSON.stringify({ type: 'close', data: { offerId: offer.id } }))
                else if (ws == offer.answererSocket)
                    send(offer.offererSocket, JSON.stringify({ type: 'close', data: { offerId: offer.id } }))
            })

            wss.delete(ws)

            offers.removeSocketOffers(ws)

            console.log(`closed ws, ws count:${wss.size}, offers count:${offers.count}`)
        })
    })

    return app
}

function send(socket, payload) {
    try {
        socket && socket.readyState == 1 && socket.send(payload)
    }
    catch (error) {
        console.log(`error send message on socket ${error}`)
    }
}

createExpressApp(8999)